//! Dev server: serves the built frontend plus a `/api/timeline` endpoint
//! that returns whatever timeline JSON file `analyze` last wrote.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tower_http::services::ServeDir;

#[derive(Clone)]
struct ServerState {
    data_path: Arc<PathBuf>,
}

pub async fn run(host: &str, port: u16, data_path: PathBuf) -> Result<(), String> {
    println!("Starting server on http://{host}:{port}");
    println!("Timeline data: {}", data_path.display());

    // Say so at startup rather than letting the first request 404 with no
    // explanation — this is the common "ran `serve` before `analyze`" case.
    if !data_path.exists() {
        println!(
            "Warning: {} does not exist yet. Run `codevis analyze <repo>` to create it.",
            data_path.display()
        );
    }

    let app = router(data_path);

    let listener = tokio::net::TcpListener::bind((host, port))
        .await
        .map_err(|e| format!("Could not bind to {host}:{port}: {e}"))?;

    axum::serve(listener, app).await.map_err(|e| e.to_string())
}

/// Multi-project mode: the `/api/projects*`/`/api/jobs/*` surface from
/// `projects_api`, plus the same static-asset fallback as legacy mode.
pub async fn run_multi_project(host: &str, port: u16, data_dir: PathBuf) -> Result<(), String> {
    println!("Starting server on http://{host}:{port}");
    println!("Project data directory: {}", data_dir.display());

    let app = multi_project_router(data_dir)?;

    let listener = tokio::net::TcpListener::bind((host, port))
        .await
        .map_err(|e| format!("Could not bind to {host}:{port}: {e}"))?;

    axum::serve(listener, app).await.map_err(|e| e.to_string())
}

fn multi_project_router(data_dir: PathBuf) -> Result<Router, String> {
    let projects = crate::projects_api::projects_router(data_dir)?;
    let static_dir = ServeDir::new("frontend/build");
    Ok(projects.fallback_service(static_dir))
}

/// Split out from `run` so tests can drive it with `ServiceExt::oneshot`
/// without binding a port.
fn router(data_path: PathBuf) -> Router {
    let state = ServerState {
        data_path: Arc::new(data_path),
    };
    let static_dir = ServeDir::new("frontend/build");

    // No CORS layer: the frontend is same-origin in both supported setups
    // (this server serves `frontend/build` itself, and the vite dev server
    // proxies `/api` from Node, server-side). A permissive layer would let
    // any page the developer happens to visit read the analyzed repo's
    // history cross-origin.
    Router::new()
        .route("/api/timeline", get(get_timeline))
        .with_state(state)
        .fallback_service(static_dir)
}

pub(crate) fn json_error(status: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({ "error": message }).to_string();
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

async fn get_timeline(State(state): State<ServerState>) -> Response {
    match tokio::fs::read(state.data_path.as_path()).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            bytes,
        )
            .into_response(),
        // A missing file and an unreadable one are different operator
        // problems; collapsing both into 404 hid permission and
        // is-a-directory failures behind "not found".
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            json_error(StatusCode::NOT_FOUND, "Timeline data not found")
        }
        Err(err) => {
            eprintln!(
                "Failed to read timeline data at {}: {err}",
                state.data_path.display()
            );
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Timeline data could not be read",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn get(data_path: PathBuf) -> (StatusCode, String) {
        let response = router(data_path)
            .oneshot(
                Request::builder()
                    .uri("/api/timeline")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn serves_the_data_file_verbatim() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("timeline.json");
        std::fs::write(&path, r#"{"metadata":{"repo_name":"x"}}"#).unwrap();

        let (status, body) = get(path).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, r#"{"metadata":{"repo_name":"x"}}"#);
    }

    #[tokio::test]
    async fn missing_file_is_404_with_a_json_error() {
        let dir = tempfile::TempDir::new().unwrap();

        let (status, body) = get(dir.path().join("nope.json")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains("Timeline data not found"), "body: {body}");
    }

    /// A path that exists but cannot be read is an operator problem, not a
    /// missing file — collapsing it into 404 hid permission errors.
    #[tokio::test]
    async fn unreadable_path_is_500_not_404() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("a-directory");
        std::fs::create_dir(&path).unwrap();

        let (status, body) = get(path).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(body.contains("could not be read"), "body: {body}");
    }
}
