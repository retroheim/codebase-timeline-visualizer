//! REST surface for the multi-project registry: list/register/delete
//! projects, trigger or refresh an analyze run, poll its job status, and
//! serve a specific project's `timeline.json`. Kept out of `server.rs` to
//! avoid tripling that file's size — `server.rs` still owns the legacy
//! single-file `/api/timeline` route and static-asset serving.

use std::fs;
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::git_source;
use crate::jobs::JobManager;
use crate::registry::{Project, ProjectSource, Registry};
use crate::server::json_error;

#[derive(Clone)]
struct ProjectsState {
    registry: Arc<Mutex<Registry>>,
    jobs: Arc<JobManager>,
}

/// Split out from wherever it's mounted so tests can drive it with
/// `ServiceExt::oneshot` without binding a port, mirroring `server::router`.
pub fn projects_router(data_dir: PathBuf) -> Result<Router, String> {
    let registry = Registry::load(&data_dir)?;
    let state = ProjectsState {
        registry: Arc::new(Mutex::new(registry)),
        jobs: Arc::new(JobManager::new()),
    };

    Ok(Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route(
            "/api/projects/:id",
            axum::routing::delete(delete_project).patch(rename_project),
        )
        .route("/api/projects/:id/timeline", get(get_project_timeline))
        .route("/api/projects/:id/analyze", post(trigger_analyze))
        .route("/api/jobs/:job_id", get(get_job))
        .with_state(state))
}

async fn list_projects(State(state): State<ProjectsState>) -> Response {
    let projects: Vec<Project> = state
        .registry
        .lock()
        .unwrap()
        .list()
        .into_iter()
        .map(Project::redacted)
        .collect();
    Json(projects).into_response()
}

#[derive(Deserialize)]
struct CreateProjectRequest {
    path: Option<String>,
    url: Option<String>,
    display_name: Option<String>,
}

async fn create_project(
    State(state): State<ProjectsState>,
    Json(req): Json<CreateProjectRequest>,
) -> Response {
    let source = match (req.path, req.url) {
        (Some(path), None) => {
            if path.trim().is_empty() {
                return json_error(StatusCode::BAD_REQUEST, "path must not be empty");
            }
            ProjectSource::LocalPath { path }
        }
        (None, Some(url)) => match git_source::validate_git_url(&url) {
            Ok(()) => ProjectSource::GitUrl { url },
            Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
        },
        _ => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Provide exactly one of `path` or `url`",
            )
        }
    };

    let display_name = req
        .display_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| default_display_name(&source));

    let mut registry = state.registry.lock().unwrap();
    match registry.register(display_name, source) {
        Ok(project) => (StatusCode::CREATED, Json(project.redacted())).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

fn default_display_name(source: &ProjectSource) -> String {
    match source {
        ProjectSource::LocalPath { path } => StdPath::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone()),
        ProjectSource::GitUrl { url } => {
            let trimmed = url.trim_end_matches('/').trim_end_matches(".git");
            trimmed.rsplit(['/', ':']).next().unwrap_or(url).to_string()
        }
    }
}

async fn delete_project(State(state): State<ProjectsState>, Path(id): Path<String>) -> Response {
    match state.registry.lock().unwrap().remove(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        // A real deletion failure (e.g. a concurrent analyze job holding
        // the directory open) is not "not found" — the project is still
        // fully registered (`Registry::remove` leaves it that way on
        // failure) and the caller should be able to tell the difference
        // and retry, not conclude the project never existed.
        Err(e) if e.contains("Unknown project") => json_error(StatusCode::NOT_FOUND, &e),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

#[derive(Deserialize)]
struct RenameProjectRequest {
    display_name: String,
}

async fn rename_project(
    State(state): State<ProjectsState>,
    Path(id): Path<String>,
    Json(req): Json<RenameProjectRequest>,
) -> Response {
    match state.registry.lock().unwrap().rename(&id, req.display_name) {
        Ok(project) => Json(project.redacted()).into_response(),
        Err(e) if e.contains("Unknown project") => json_error(StatusCode::NOT_FOUND, &e),
        Err(e) => json_error(StatusCode::BAD_REQUEST, &e),
    }
}

async fn get_project_timeline(
    State(state): State<ProjectsState>,
    Path(id): Path<String>,
) -> Response {
    let timeline_path = {
        let registry = state.registry.lock().unwrap();
        if registry.get(&id).is_none() {
            return json_error(StatusCode::NOT_FOUND, "Unknown project");
        }
        registry.timeline_path(&id)
    };

    match tokio::fs::read(&timeline_path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            bytes,
        )
            .into_response(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => json_error(
            StatusCode::NOT_FOUND,
            "Timeline data not found - has this project been analyzed yet?",
        ),
        Err(err) => {
            eprintln!(
                "Failed to read timeline data at {}: {err}",
                timeline_path.display()
            );
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Timeline data could not be read",
            )
        }
    }
}

async fn trigger_analyze(State(state): State<ProjectsState>, Path(id): Path<String>) -> Response {
    if state.registry.lock().unwrap().get(&id).is_none() {
        return json_error(StatusCode::NOT_FOUND, "Unknown project");
    }
    match spawn_analyze_job(&state, id) {
        Ok(job_id) => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "job_id": job_id })),
        )
            .into_response(),
        Err(e) => json_error(StatusCode::CONFLICT, &e),
    }
}

async fn get_job(State(state): State<ProjectsState>, Path(job_id): Path<String>) -> Response {
    match state.jobs.get(&job_id) {
        Some(job) => Json(job).into_response(),
        None => json_error(StatusCode::NOT_FOUND, "Unknown job"),
    }
}

/// Registers the analyze job with the registry (guarding against a second
/// concurrent run for the same project) and hands the actual work to a
/// blocking task. `analyze_commits` (rayon) and any git clone/fetch are both
/// synchronous and potentially slow — running them here would stall axum's
/// async executor for every other request.
fn spawn_analyze_job(state: &ProjectsState, project_id: String) -> Result<String, String> {
    let expected_generation = {
        let mut reg = state.registry.lock().unwrap();
        reg.try_start_analyzing(&project_id)?;
        reg.generation(&project_id)
    };

    let job_id = state.jobs.start(project_id.clone());
    let registry = state.registry.clone();
    let jobs = state.jobs.clone();
    let job_id_for_closure = job_id.clone();
    let started_at = chrono::Utc::now().timestamp();

    // Deliberately not awaiting the returned `JoinHandle`: the job keeps
    // running to completion in the background regardless (only `.abort()`
    // would cancel it), which is exactly the fire-and-forget behavior the
    // polling design needs — the caller gets a job id back immediately.
    tokio::task::spawn_blocking(move || {
        let result = run_project_analyze(&registry, &project_id, expected_generation);
        let finished_at = chrono::Utc::now().timestamp();

        let mut reg = registry.lock().unwrap();
        if reg.generation(&project_id) == expected_generation {
            reg.finish(&project_id, result.clone(), started_at, finished_at);
        } else {
            // The project this job was analyzing was deleted and/or
            // re-registered while the job ran. It already refused to write
            // `timeline.json` (see `run_project_analyze`'s own check) —
            // calling `finish()` here too would still be wrong, since the
            // id now names a *different* project and this stale result has
            // nothing to say about it.
            eprintln!(
                "Discarding stale analyze result for {project_id}: project was deleted and/or re-registered during this run"
            );
        }
        drop(reg);
        jobs.finish(&job_id_for_closure, result);
    });

    Ok(job_id)
}

fn run_project_analyze(
    registry: &Mutex<Registry>,
    project_id: &str,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    let (source, timeline_path, clone_path) = {
        let reg = registry.lock().unwrap();
        let project = reg
            .get(project_id)
            .ok_or_else(|| format!("Unknown project: {project_id}"))?;
        (
            project.source,
            reg.timeline_path(project_id),
            reg.clone_path(project_id),
        )
    };

    let repo_path = match &source {
        ProjectSource::LocalPath { path } => PathBuf::from(path),
        ProjectSource::GitUrl { url } => {
            let refreshed = clone_path.exists() && git_source::update_repo(&clone_path).is_ok();
            if !refreshed {
                if clone_path.exists() {
                    fs::remove_dir_all(&clone_path)
                        .map_err(|e| format!("Could not remove stale clone: {e}"))?;
                }
                git_source::clone_repo(url, &clone_path)?;
            }
            clone_path.clone()
        }
    };

    let timeline_data = crate::pipeline::analyze_repository(&repo_path, false)?;

    // Re-validate identity right before writing: clone+analyze can take a
    // while, giving a concurrent DELETE-then-re-register (which reuses this
    // exact slug id — see `Registry::register`'s generation comment) a wide
    // window to swap in a different project underneath this job. Without
    // this check, the stale job would silently overwrite the *new*
    // project's `timeline.json` with data analyzed from the *old* one.
    if registry.lock().unwrap().generation(project_id) != expected_generation {
        return Err(format!(
            "Project {project_id} was deleted or re-registered during analysis; discarding stale result"
        ));
    }

    crate::exporter::export_json(&timeline_data, &timeline_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn call(
        router: Router,
        method: &str,
        uri: &str,
        body: Option<&str>,
    ) -> (StatusCode, String) {
        let mut builder = Request::builder().method(method).uri(uri);
        if body.is_some() {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        let request = builder
            .body(
                body.map(|b| Body::from(b.to_string()))
                    .unwrap_or(Body::empty()),
            )
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn list_projects_starts_empty() {
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let (status, body) = call(router, "GET", "/api/projects", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "[]");
    }

    #[tokio::test]
    async fn create_project_requires_exactly_one_source() {
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let (status, body) = call(router, "POST", "/api/projects", Some("{}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("exactly one"), "body: {body}");
    }

    #[tokio::test]
    async fn create_project_rejects_a_bad_git_url() {
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let (status, body) = call(
            router,
            "POST",
            "/api/projects",
            Some(r#"{"url":"--upload-pack=x"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("start with"), "body: {body}");
    }

    #[tokio::test]
    async fn create_then_list_round_trips() {
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let (status, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(r#"{"path":"/tmp/my-repo"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert!(body.contains("\"id\":\"my-repo\""), "body: {body}");

        let (_, listed) = call(router, "GET", "/api/projects", None).await;
        assert!(listed.contains("my-repo"), "listed: {listed}");
    }

    #[tokio::test]
    async fn timeline_for_unanalyzed_project_is_404() {
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let (_, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(r#"{"path":"/tmp/my-repo"}"#),
        )
        .await;
        let id = body
            .split("\"id\":\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();

        let (status, _) = call(router, "GET", &format!("/api/projects/{id}/timeline"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn analyze_unknown_project_is_404() {
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let (status, _) = call(router, "POST", "/api/projects/nope/analyze", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_unknown_project_is_404() {
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let (status, _) = call(router, "DELETE", "/api/projects/nope", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn rename_project_updates_display_name() {
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let (_, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(r#"{"path":"/tmp/my-repo"}"#),
        )
        .await;
        let id = extract_field(&body, "id");

        let (status, body) = call(
            router.clone(),
            "PATCH",
            &format!("/api/projects/{id}"),
            Some(r#"{"display_name":"Renamed"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("\"display_name\":\"Renamed\""),
            "body: {body}"
        );

        // The id itself doesn't change — the same id still resolves, now
        // carrying the new name, rather than the rename creating a new entry.
        let (_, listed) = call(router, "GET", "/api/projects", None).await;
        assert!(
            listed.contains(&format!("\"id\":\"{id}\"")),
            "listed: {listed}"
        );
        assert!(
            listed.contains("\"display_name\":\"Renamed\""),
            "listed: {listed}"
        );
    }

    #[tokio::test]
    async fn rename_unknown_project_is_404() {
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let (status, _) = call(
            router,
            "PATCH",
            "/api/projects/nope",
            Some(r#"{"display_name":"New"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn rename_to_an_empty_name_is_rejected() {
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let (_, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(r#"{"path":"/tmp/my-repo"}"#),
        )
        .await;
        let id = extract_field(&body, "id");

        let (status, _) = call(
            router,
            "PATCH",
            &format!("/api/projects/{id}"),
            Some(r#"{"display_name":"   "}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    fn git(args: &[&str], dir: &StdPath) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test User")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test User")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    /// A tiny real repo with one commit, for exercising the actual
    /// clone/analyze pipeline rather than mocking it.
    fn fixture_repo() -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().unwrap();
        git(&["init", "-q", "-b", "main"], dir.path());
        fs::write(dir.path().join("a.txt"), "one").unwrap();
        git(&["add", "."], dir.path());
        git(&["commit", "-q", "-m", "first"], dir.path());
        dir
    }

    fn add_commit(repo: &StdPath, name: &str) {
        fs::write(repo.join(name), "content").unwrap();
        git(&["add", "."], repo);
        git(&["commit", "-q", "-m", "more"], repo);
    }

    /// Parses `total_commits` out of a `timeline.json` body as a real
    /// number rather than substring-matching the raw JSON text — a
    /// substring check like `body.contains("\"total_commits\": 1")` would
    /// false-positive against an actual value of e.g. `10` or `12`.
    fn total_commits(timeline_json: &str) -> u64 {
        let value: serde_json::Value = serde_json::from_str(timeline_json).expect("valid JSON");
        value["metadata"]["total_commits"]
            .as_u64()
            .expect("total_commits is a number")
    }

    fn extract_field(body: &str, field: &str) -> String {
        body.split(&format!("\"{field}\":\""))
            .nth(1)
            .unwrap_or_else(|| panic!("no {field} field in {body}"))
            .split('"')
            .next()
            .unwrap()
            .to_string()
    }

    /// Polls `/api/jobs/:id` until it leaves the `running` state. The
    /// analyze itself runs on tokio's blocking pool via `spawn_blocking`,
    /// which works the same under the default current-thread test runtime
    /// as it does in the real server — a separate thread pool, not the
    /// async executor.
    async fn poll_job(router: &Router, job_id: &str) -> String {
        for _ in 0..500 {
            let (_, body) = call(router.clone(), "GET", &format!("/api/jobs/{job_id}"), None).await;
            if !body.contains("\"running\"") {
                return body;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("job {job_id} did not settle in time");
    }

    #[tokio::test]
    async fn full_local_path_analyze_flow_produces_a_readable_timeline() {
        let repo = fixture_repo();
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();

        let (status, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(&format!(r#"{{"path":"{}"}}"#, repo.path().display())),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let id = extract_field(&body, "id");

        let (status, body) = call(
            router.clone(),
            "POST",
            &format!("/api/projects/{id}/analyze"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let job_id = extract_field(&body, "job_id");

        let job_body = poll_job(&router, &job_id).await;
        assert!(job_body.contains("\"succeeded\""), "job body: {job_body}");

        let (status, timeline) =
            call(router, "GET", &format!("/api/projects/{id}/timeline"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(total_commits(&timeline), 1, "timeline: {timeline}");
    }

    #[tokio::test]
    async fn analyze_history_accumulates_across_refreshes() {
        let repo = fixture_repo();
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();

        let (_, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(&format!(r#"{{"path":"{}"}}"#, repo.path().display())),
        )
        .await;
        let id = extract_field(&body, "id");

        for _ in 0..2 {
            let (_, body) = call(
                router.clone(),
                "POST",
                &format!("/api/projects/{id}/analyze"),
                None,
            )
            .await;
            let job_id = extract_field(&body, "job_id");
            poll_job(&router, &job_id).await;
        }

        let (_, listed) = call(router, "GET", "/api/projects", None).await;
        let projects: serde_json::Value = serde_json::from_str(&listed).unwrap();
        let history = projects[0]["history"].as_array().unwrap();
        assert_eq!(history.len(), 2, "history: {history:?}");
        assert_eq!(history[0]["outcome"]["state"], "succeeded");
        assert!(history[0]["started_at"].as_i64().unwrap() > 0);
        assert!(
            history[0]["finished_at"].as_i64().unwrap()
                >= history[0]["started_at"].as_i64().unwrap()
        );
    }

    #[tokio::test]
    async fn git_url_project_clones_then_refresh_pulls_new_commits() {
        let source = fixture_repo();
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let url = format!("file://{}", source.path().display());

        let (status, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(&format!(r#"{{"url":"{url}"}}"#)),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let id = extract_field(&body, "id");

        let (_, body) = call(
            router.clone(),
            "POST",
            &format!("/api/projects/{id}/analyze"),
            None,
        )
        .await;
        let job_id = extract_field(&body, "job_id");
        let job_body = poll_job(&router, &job_id).await;
        assert!(job_body.contains("\"succeeded\""), "job body: {job_body}");

        let (_, timeline) = call(
            router.clone(),
            "GET",
            &format!("/api/projects/{id}/timeline"),
            None,
        )
        .await;
        assert_eq!(total_commits(&timeline), 1, "timeline: {timeline}");

        // Refresh: new commit lands upstream, then the refresh should pull
        // it via `update_repo` (fetch + reset), not silently miss it.
        add_commit(source.path(), "b.txt");
        let (status, body) = call(
            router.clone(),
            "POST",
            &format!("/api/projects/{id}/analyze"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let job_id = extract_field(&body, "job_id");
        let job_body = poll_job(&router, &job_id).await;
        assert!(job_body.contains("\"succeeded\""), "job body: {job_body}");

        let (_, timeline) =
            call(router, "GET", &format!("/api/projects/{id}/timeline"), None).await;
        assert_eq!(total_commits(&timeline), 2, "timeline: {timeline}");
    }

    /// End-to-end failure path: `analyze_repository` fails for a
    /// `LocalPath` that isn't a git repo, and the job/project surface must
    /// actually reflect that over HTTP, not just internally.
    #[tokio::test]
    async fn analyze_of_a_non_git_local_path_surfaces_as_a_failed_job_and_errored_project() {
        let not_a_repo = tempfile::TempDir::new().unwrap();
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();

        let (_, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(&format!(r#"{{"path":"{}"}}"#, not_a_repo.path().display())),
        )
        .await;
        let id = extract_field(&body, "id");

        let (status, body) = call(
            router.clone(),
            "POST",
            &format!("/api/projects/{id}/analyze"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let job_id = extract_field(&body, "job_id");

        let job_body = poll_job(&router, &job_id).await;
        assert!(job_body.contains("\"failed\""), "job body: {job_body}");

        let (_, listed) = call(router, "GET", "/api/projects", None).await;
        let projects: serde_json::Value = serde_json::from_str(&listed).unwrap();
        assert_eq!(projects[0]["status"]["state"], "error", "listed: {listed}");
    }

    /// The re-clone fallback: when an existing clone can no longer be
    /// updated in place (corrupted `.git`, here), refresh must delete and
    /// re-clone rather than leaving the project stuck failing forever.
    #[tokio::test]
    async fn refresh_reclones_when_the_existing_clone_can_no_longer_be_updated() {
        let source = fixture_repo();
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();
        let url = format!("file://{}", source.path().display());

        let (_, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(&format!(r#"{{"url":"{url}"}}"#)),
        )
        .await;
        let id = extract_field(&body, "id");

        let (_, body) = call(
            router.clone(),
            "POST",
            &format!("/api/projects/{id}/analyze"),
            None,
        )
        .await;
        let job_id = extract_field(&body, "job_id");
        let job_body = poll_job(&router, &job_id).await;
        assert!(job_body.contains("\"succeeded\""), "job body: {job_body}");

        // Corrupt the clone so `git fetch origin` (update_repo) fails,
        // forcing run_project_analyze into the delete+re-clone branch.
        let clone_path = dir.path().join("projects").join(&id).join("repo");
        fs::remove_dir_all(clone_path.join(".git")).unwrap();
        assert!(
            git_source::update_repo(&clone_path).is_err(),
            "test setup: corruption should break update_repo"
        );

        add_commit(source.path(), "b.txt");
        let (status, body) = call(
            router.clone(),
            "POST",
            &format!("/api/projects/{id}/analyze"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let job_id = extract_field(&body, "job_id");
        let job_body = poll_job(&router, &job_id).await;
        assert!(job_body.contains("\"succeeded\""), "job body: {job_body}");

        let (_, timeline) =
            call(router, "GET", &format!("/api/projects/{id}/timeline"), None).await;
        assert_eq!(total_commits(&timeline), 2, "timeline: {timeline}");
    }

    #[tokio::test]
    async fn analyzing_the_same_project_twice_concurrently_is_rejected() {
        let repo = fixture_repo();
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();

        let (_, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(&format!(r#"{{"path":"{}"}}"#, repo.path().display())),
        )
        .await;
        let id = extract_field(&body, "id");

        let (first, body) = call(
            router.clone(),
            "POST",
            &format!("/api/projects/{id}/analyze"),
            None,
        )
        .await;
        assert_eq!(first, StatusCode::ACCEPTED);
        let job_id = extract_field(&body, "job_id");

        let (second, _) = call(
            router.clone(),
            "POST",
            &format!("/api/projects/{id}/analyze"),
            None,
        )
        .await;
        assert_eq!(second, StatusCode::CONFLICT);

        // The first analyze is a detached `spawn_blocking` task — not tied
        // to this test function's lifetime. Without waiting for it, `repo`/
        // `dir` (both `TempDir`s) can be dropped and deleted from disk while
        // that background task is still reading/writing them, a real race
        // even though it wouldn't flip this test's own pass/fail.
        poll_job(&router, &job_id).await;
    }

    #[tokio::test]
    async fn delete_after_analyze_removes_the_project_directory_from_disk() {
        let repo = fixture_repo();
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();

        let (_, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(&format!(r#"{{"path":"{}"}}"#, repo.path().display())),
        )
        .await;
        let id = extract_field(&body, "id");
        let project_dir = dir.path().join("projects").join(&id);
        assert!(project_dir.exists());

        let (_, body) = call(
            router.clone(),
            "POST",
            &format!("/api/projects/{id}/analyze"),
            None,
        )
        .await;
        let job_id = extract_field(&body, "job_id");
        poll_job(&router, &job_id).await;
        assert!(project_dir.join("timeline.json").exists());

        let (status, _) = call(router, "DELETE", &format!("/api/projects/{id}"), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(!project_dir.exists());
    }

    /// A `GitUrl` project's embedded credentials must never appear verbatim
    /// in an API response — `list`, `create`, and `rename` all serialize a
    /// `Project` and must redact it first.
    #[tokio::test]
    async fn credentials_are_redacted_in_create_list_and_rename_responses() {
        let dir = tempfile::TempDir::new().unwrap();
        let router = projects_router(dir.path().to_path_buf()).unwrap();

        let (status, body) = call(
            router.clone(),
            "POST",
            "/api/projects",
            Some(r#"{"url":"https://user:s3cr3t-token@github.com/owner/repo.git"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert!(
            !body.contains("s3cr3t-token"),
            "create response leaked the credential: {body}"
        );
        assert!(body.contains("https://***@github.com"), "body: {body}");
        let id = extract_field(&body, "id");

        let (_, listed) = call(router.clone(), "GET", "/api/projects", None).await;
        assert!(
            !listed.contains("s3cr3t-token"),
            "list response leaked the credential: {listed}"
        );
        assert!(
            listed.contains("https://***@github.com"),
            "listed: {listed}"
        );

        let (_, renamed) = call(
            router,
            "PATCH",
            &format!("/api/projects/{id}"),
            Some(r#"{"display_name":"Renamed"}"#),
        )
        .await;
        assert!(
            !renamed.contains("s3cr3t-token"),
            "rename response leaked the credential: {renamed}"
        );
    }

    /// The regression test for the delete-during-analyze race: a job that
    /// captured its project's generation before a long clone+analyze must
    /// refuse to write over a *different* project that later reused the
    /// same slug id, rather than silently clobbering it.
    #[tokio::test]
    async fn stale_analyze_job_does_not_overwrite_a_reregistered_project() {
        let repo = fixture_repo();
        let dir = tempfile::TempDir::new().unwrap();
        let registry = Mutex::new(Registry::load(dir.path()).unwrap());

        let old_id = {
            let mut reg = registry.lock().unwrap();
            let project = reg
                .register(
                    "Repo".to_string(),
                    ProjectSource::LocalPath {
                        path: repo.path().display().to_string(),
                    },
                )
                .unwrap();
            reg.try_start_analyzing(&project.id).unwrap();
            project.id
        };
        let stale_generation = registry.lock().unwrap().generation(&old_id);

        // Simulate the race: the project is deleted and a *different*
        // project re-registers under the identical slug id while the first
        // job (still holding `stale_generation`) is "mid-analyze".
        {
            let mut reg = registry.lock().unwrap();
            reg.remove(&old_id).unwrap();
            let new_project = reg
                .register(
                    "Repo".to_string(),
                    ProjectSource::LocalPath {
                        path: repo.path().display().to_string(),
                    },
                )
                .unwrap();
            assert_eq!(new_project.id, old_id, "test assumes id reuse");
        }
        let new_timeline_path = registry.lock().unwrap().timeline_path(&old_id);
        assert!(
            !new_timeline_path.exists(),
            "new project must not already have a timeline.json"
        );

        let result = run_project_analyze(&registry, &old_id, stale_generation);

        assert!(
            result.is_err(),
            "stale job must refuse to write: {result:?}"
        );
        assert!(
            !new_timeline_path.exists(),
            "stale job must not have written timeline.json into the new project's directory"
        );
    }
}
