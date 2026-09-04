//! Multi-project registry: durable metadata for every project the server
//! knows about (source, status, last-analyzed time), persisted as JSON under
//! the server's data directory. This is the record of *what* projects exist
//! and *what state* they're in; the actual `timeline.json` each one produces
//! lives alongside it on disk and is served straight from the filesystem
//! (see `projects_api.rs`), not held in memory here.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectSource {
    LocalPath { path: String },
    GitUrl { url: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ProjectStatus {
    NeverAnalyzed,
    Analyzing,
    Ready,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RunOutcome {
    Succeeded,
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalysisRun {
    pub started_at: i64,
    pub finished_at: i64,
    pub outcome: RunOutcome,
}

/// How many past runs to keep per project. A cap, not a real log store — this
/// is meant for "did my last few refreshes work", not an audit trail, so
/// unbounded growth in `registry.json` isn't worth guarding against.
const HISTORY_LIMIT: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub display_name: String,
    pub source: ProjectSource,
    pub status: ProjectStatus,
    /// Unix timestamp (seconds) of the last successful analysis, if any.
    pub last_analyzed: Option<i64>,
    /// Most recent run first, capped at `HISTORY_LIMIT`. Defaults to empty
    /// for registries saved before this field existed — `serde(default)` so
    /// loading an older `registry.json` doesn't fail.
    #[serde(default)]
    pub history: Vec<AnalysisRun>,
}

impl Project {
    /// Masks credentials embedded in a `GitUrl` source before this project
    /// is ever serialized into an API response. `Registry`'s own methods
    /// intentionally keep returning the *unredacted* `Project` — the analyze
    /// pipeline needs the real credential to clone/fetch, and so does
    /// `registry.json` on disk — this is applied only at the HTTP boundary
    /// in `projects_api.rs`.
    pub fn redacted(mut self) -> Self {
        if let ProjectSource::GitUrl { url } = &self.source {
            self.source = ProjectSource::GitUrl {
                url: crate::git_source::redact_url(url),
            };
        }
        self
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RegistryFile {
    projects: Vec<Project>,
}

pub struct Registry {
    data_dir: PathBuf,
    projects: HashMap<String, Project>,
    /// Bumped every time an id is (re-)assigned by `register`, in-memory
    /// only — not persisted, not part of any API response. A slug id gets
    /// reused when a project is deleted and re-registered with the same
    /// display name; this lets an in-flight analyze job started against the
    /// *old* registration detect that it's now stale before it can write a
    /// stale result into the *new* project's directory. Doesn't need to
    /// survive a restart: a restart already invalidates every in-flight job
    /// (see `load`'s `Analyzing` -> `Error` downgrade).
    generations: HashMap<String, u64>,
}

impl Registry {
    /// Loads `registry.json` from `data_dir`, creating an empty registry if
    /// it doesn't exist yet. Any project still marked `Analyzing` is
    /// downgraded to `Error` — no in-flight job could have survived a
    /// process restart, and leaving it `Analyzing` forever would wedge it:
    /// `try_start_analyzing`'s guard would reject every future retry.
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir)
            .map_err(|e| format!("Could not create {}: {e}", data_dir.display()))?;
        fs::create_dir_all(data_dir.join("projects"))
            .map_err(|e| format!("Could not create projects dir: {e}"))?;

        let path = registry_path(data_dir);
        let mut projects = HashMap::new();
        if path.exists() {
            let raw = fs::read_to_string(&path)
                .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
            let file: RegistryFile = serde_json::from_str(&raw)
                .map_err(|e| format!("Could not parse {}: {e}", path.display()))?;
            for mut project in file.projects {
                if project.status == ProjectStatus::Analyzing {
                    project.status = ProjectStatus::Error {
                        message: "Interrupted by server restart".to_string(),
                    };
                }
                projects.insert(project.id.clone(), project);
            }
        }

        let registry = Registry {
            data_dir: data_dir.to_path_buf(),
            projects,
            generations: HashMap::new(),
        };
        registry.save()?;
        Ok(registry)
    }

    /// Writes `registry.json` via a temp file + rename so a crash mid-write
    /// can never leave a half-written, unparseable registry behind.
    fn save(&self) -> Result<(), String> {
        let mut projects: Vec<&Project> = self.projects.values().collect();
        projects.sort_by(|a, b| a.id.cmp(&b.id));
        let file = RegistryFile {
            projects: projects.into_iter().cloned().collect(),
        };
        let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;

        let path = registry_path(&self.data_dir);
        let tmp_path = path.with_extension("json.tmp");
        fs::write(&tmp_path, json)
            .map_err(|e| format!("Could not write {}: {e}", tmp_path.display()))?;
        fs::rename(&tmp_path, &path)
            .map_err(|e| format!("Could not save {}: {e}", path.display()))?;
        Ok(())
    }

    pub fn list(&self) -> Vec<Project> {
        let mut projects: Vec<Project> = self.projects.values().cloned().collect();
        projects.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        projects
    }

    pub fn get(&self, id: &str) -> Option<Project> {
        self.projects.get(id).cloned()
    }

    /// The current generation for `id`, or `None` if it isn't registered.
    /// Two calls returning different values (or `None` where a job expected
    /// `Some`) mean the project was removed and/or re-registered in between.
    pub fn generation(&self, id: &str) -> Option<u64> {
        self.generations.get(id).copied()
    }

    pub fn register(
        &mut self,
        display_name: String,
        source: ProjectSource,
    ) -> Result<Project, String> {
        let id = self.unique_id(&display_name);
        fs::create_dir_all(self.project_dir(&id))
            .map_err(|e| format!("Could not create project directory: {e}"))?;

        let project = Project {
            id: id.clone(),
            display_name,
            source,
            status: ProjectStatus::NeverAnalyzed,
            last_analyzed: None,
            history: Vec::new(),
        };
        *self.generations.entry(id.clone()).or_insert(0) += 1;
        self.projects.insert(id, project.clone());
        self.save()?;
        Ok(project)
    }

    /// Registers a project and immediately marks it `Ready`, copying an
    /// already-produced `timeline.json` into place instead of running
    /// `analyze_repository`. Used once, at startup, to bootstrap-import a
    /// pre-existing single-file `timeline.json` from before multi-project
    /// mode existed, so upgrading users don't lose visibility into
    /// already-analyzed data.
    pub fn register_ready(
        &mut self,
        display_name: String,
        source: ProjectSource,
        timeline_json_path: &Path,
    ) -> Result<Project, String> {
        let project = self.register(display_name, source)?;
        let dest = self.timeline_path(&project.id);
        fs::copy(timeline_json_path, &dest)
            .map_err(|e| format!("Could not import {}: {e}", timeline_json_path.display()))?;
        let now = chrono::Utc::now().timestamp();
        // No real start time exists for an import — the run wasn't timed,
        // it was copied. Recording it as instantaneous is honest about that.
        self.finish(&project.id, Ok(()), now, now);
        Ok(self.get(&project.id).expect("just registered"))
    }

    /// Test-and-set guard: only one analyze job may run for a project at a
    /// time. Errs (rather than queuing) if one is already in flight, so the
    /// caller can surface a 409 instead of silently racing two `git reset
    /// --hard`/`analyze_commits` runs against the same clone directory.
    pub fn try_start_analyzing(&mut self, id: &str) -> Result<(), String> {
        let project = self
            .projects
            .get_mut(id)
            .ok_or_else(|| format!("Unknown project: {id}"))?;
        if project.status == ProjectStatus::Analyzing {
            return Err("Project is already being analyzed".to_string());
        }
        project.status = ProjectStatus::Analyzing;
        self.save()
    }

    pub fn finish(
        &mut self,
        id: &str,
        result: Result<(), String>,
        started_at: i64,
        finished_at: i64,
    ) {
        if let Some(project) = self.projects.get_mut(id) {
            let outcome = match &result {
                Ok(()) => RunOutcome::Succeeded,
                Err(message) => RunOutcome::Failed {
                    message: message.clone(),
                },
            };
            project.history.insert(
                0,
                AnalysisRun {
                    started_at,
                    finished_at,
                    outcome,
                },
            );
            project.history.truncate(HISTORY_LIMIT);

            project.status = match result {
                Ok(()) => {
                    project.last_analyzed = Some(finished_at);
                    ProjectStatus::Ready
                }
                Err(message) => ProjectStatus::Error { message },
            };
        }
        // Best-effort: if this fails there's nothing more useful to do than
        // log it, and this method is called from a background job with no
        // caller left to hand a `Result` back to.
        if let Err(e) = self.save() {
            eprintln!("Could not save registry after finishing {id}: {e}");
        }
    }

    /// Changes only the display name — `id` (and therefore the on-disk
    /// `projects/<id>/` directory) never changes once assigned, so a rename
    /// can't invalidate an in-flight analyze job's paths or any URL a client
    /// already has pointing at this project.
    pub fn rename(&mut self, id: &str, new_display_name: String) -> Result<Project, String> {
        if new_display_name.trim().is_empty() {
            return Err("Display name must not be empty".to_string());
        }
        let project = self
            .projects
            .get_mut(id)
            .ok_or_else(|| format!("Unknown project: {id}"))?;
        project.display_name = new_display_name;
        let renamed = project.clone();
        self.save()?;
        Ok(renamed)
    }

    /// Removes the on-disk directory *before* touching the in-memory map or
    /// `registry.json` — a concurrent analyze job writing into this exact
    /// directory can make `remove_dir_all` fail, and if the in-memory entry
    /// had already been dropped at that point, the project would vanish from
    /// `list()`/`get()` while its directory (and a stale `registry.json` from
    /// before this call, once anything else saves) still existed: split-brain
    /// between what the registry claims and what's on disk. Erroring out here
    /// with the project still fully registered lets the caller retry once the
    /// contention clears, instead of resurrecting a half-deleted entry on the
    /// next `load()`.
    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        if !self.projects.contains_key(id) {
            return Err(format!("Unknown project: {id}"));
        }
        let dir = self.project_dir(id);
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|e| format!("Could not remove {}: {e}", dir.display()))?;
        }
        self.projects.remove(id);
        self.save()
    }

    pub fn project_dir(&self, id: &str) -> PathBuf {
        self.data_dir.join("projects").join(id)
    }

    pub fn timeline_path(&self, id: &str) -> PathBuf {
        self.project_dir(id).join("timeline.json")
    }

    pub fn clone_path(&self, id: &str) -> PathBuf {
        self.project_dir(id).join("repo")
    }

    fn unique_id(&self, display_name: &str) -> String {
        let base = slugify(display_name);
        if !self.projects.contains_key(&base) {
            return base;
        }
        let mut n = 2;
        loop {
            let candidate = format!("{base}-{n}");
            if !self.projects.contains_key(&candidate) {
                return candidate;
            }
            n += 1;
        }
    }
}

fn registry_path(data_dir: &Path) -> PathBuf {
    data_dir.join("registry.json")
}

fn slugify(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    let mut last_was_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "project".to_string()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_source(path: &str) -> ProjectSource {
        ProjectSource::LocalPath {
            path: path.to_string(),
        }
    }

    #[test]
    fn redacted_masks_git_url_credentials_but_leaves_local_paths_alone() {
        let git_project = Project {
            id: "x".to_string(),
            display_name: "x".to_string(),
            source: ProjectSource::GitUrl {
                url: "https://user:token@github.com/owner/repo.git".to_string(),
            },
            status: ProjectStatus::NeverAnalyzed,
            last_analyzed: None,
            history: Vec::new(),
        }
        .redacted();
        assert_eq!(
            git_project.source,
            ProjectSource::GitUrl {
                url: "https://***@github.com/owner/repo.git".to_string()
            }
        );

        let local_project = Project {
            id: "y".to_string(),
            display_name: "y".to_string(),
            source: local_source("/tmp/my-repo"),
            status: ProjectStatus::NeverAnalyzed,
            last_analyzed: None,
            history: Vec::new(),
        }
        .redacted();
        assert_eq!(local_project.source, local_source("/tmp/my-repo"));
    }

    #[test]
    fn register_then_reload_round_trips() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let project = registry
            .register("My Repo".to_string(), local_source("/tmp/my-repo"))
            .unwrap();
        assert_eq!(project.id, "my-repo");
        assert_eq!(project.status, ProjectStatus::NeverAnalyzed);

        let reloaded = Registry::load(dir.path()).unwrap();
        let fetched = reloaded.get("my-repo").unwrap();
        assert_eq!(fetched.display_name, "My Repo");
        assert_eq!(fetched.source, local_source("/tmp/my-repo"));
    }

    #[test]
    fn colliding_display_names_get_distinct_slug_ids() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let a = registry
            .register("Repo".to_string(), local_source("/a"))
            .unwrap();
        let b = registry
            .register("Repo".to_string(), local_source("/b"))
            .unwrap();
        assert_eq!(a.id, "repo");
        assert_eq!(b.id, "repo-2");
    }

    #[test]
    fn reregistering_a_deleted_id_bumps_its_generation() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let first = registry
            .register("Repo".to_string(), local_source("/a"))
            .unwrap();
        let first_gen = registry.generation(&first.id);
        assert_eq!(first_gen, Some(1));

        registry.remove(&first.id).unwrap();
        assert_eq!(
            registry.generation(&first.id),
            Some(1),
            "generation survives removal so a stale in-flight job can still detect the mismatch"
        );

        // Same display name -> same slugified id, reused.
        let second = registry
            .register("Repo".to_string(), local_source("/b"))
            .unwrap();
        assert_eq!(second.id, first.id, "id is reused after delete+re-register");
        assert_ne!(
            registry.generation(&second.id),
            first_gen,
            "a job holding the old generation must be able to detect the id was reassigned"
        );
    }

    #[test]
    fn try_start_analyzing_rejects_a_second_concurrent_run() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let project = registry
            .register("Repo".to_string(), local_source("/a"))
            .unwrap();

        registry.try_start_analyzing(&project.id).unwrap();
        let err = registry.try_start_analyzing(&project.id).unwrap_err();
        assert!(err.contains("already"), "err: {err}");
    }

    #[test]
    fn analyzing_status_is_downgraded_to_error_after_a_simulated_restart() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let project = registry
            .register("Repo".to_string(), local_source("/a"))
            .unwrap();
        registry.try_start_analyzing(&project.id).unwrap();

        let reloaded = Registry::load(dir.path()).unwrap();
        match reloaded.get(&project.id).unwrap().status {
            ProjectStatus::Error { message } => assert!(message.contains("restart")),
            other => panic!("expected Error status, got {other:?}"),
        }
    }

    #[test]
    fn finish_ok_sets_ready_and_last_analyzed() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let project = registry
            .register("Repo".to_string(), local_source("/a"))
            .unwrap();
        registry.try_start_analyzing(&project.id).unwrap();
        registry.finish(&project.id, Ok(()), 1_699_999_990, 1_700_000_000);

        let fetched = registry.get(&project.id).unwrap();
        assert_eq!(fetched.status, ProjectStatus::Ready);
        assert_eq!(fetched.last_analyzed, Some(1_700_000_000));
        assert_eq!(fetched.history.len(), 1);
        assert_eq!(fetched.history[0].started_at, 1_699_999_990);
        assert_eq!(fetched.history[0].finished_at, 1_700_000_000);
        assert_eq!(fetched.history[0].outcome, RunOutcome::Succeeded);
    }

    #[test]
    fn finish_err_sets_error_status_with_message() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let project = registry
            .register("Repo".to_string(), local_source("/a"))
            .unwrap();
        registry.try_start_analyzing(&project.id).unwrap();
        registry.finish(
            &project.id,
            Err("boom".to_string()),
            1_699_999_990,
            1_700_000_000,
        );

        match registry.get(&project.id).unwrap().status {
            ProjectStatus::Error { message } => assert_eq!(message, "boom"),
            other => panic!("expected Error status, got {other:?}"),
        }
        assert_eq!(
            registry.get(&project.id).unwrap().history[0].outcome,
            RunOutcome::Failed {
                message: "boom".to_string()
            }
        );
    }

    #[test]
    fn history_is_capped_and_newest_first() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let project = registry
            .register("Repo".to_string(), local_source("/a"))
            .unwrap();

        for i in 0..25 {
            registry.finish(&project.id, Ok(()), i, i + 1);
        }

        let history = registry.get(&project.id).unwrap().history;
        assert_eq!(history.len(), 20);
        // Most recent run (started_at == 24) comes first.
        assert_eq!(history[0].started_at, 24);
        assert_eq!(history[19].started_at, 5);
    }

    #[test]
    fn register_ready_imports_an_existing_timeline_json_as_ready() {
        let dir = tempfile::TempDir::new().unwrap();
        let src = dir.path().join("timeline.json");
        fs::write(&src, r#"{"metadata":{"repo_name":"x"}}"#).unwrap();

        let mut registry = Registry::load(dir.path()).unwrap();
        let project = registry
            .register_ready("x".to_string(), local_source("."), &src)
            .unwrap();

        assert_eq!(project.status, ProjectStatus::Ready);
        assert!(project.last_analyzed.is_some());
        let imported = fs::read_to_string(registry.timeline_path(&project.id)).unwrap();
        assert_eq!(imported, r#"{"metadata":{"repo_name":"x"}}"#);
    }

    #[test]
    fn rename_updates_display_name_but_keeps_the_same_id() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let project = registry
            .register("Old Name".to_string(), local_source("/a"))
            .unwrap();

        let renamed = registry
            .rename(&project.id, "New Name".to_string())
            .unwrap();
        assert_eq!(renamed.id, project.id);
        assert_eq!(renamed.display_name, "New Name");

        let reloaded = Registry::load(dir.path()).unwrap();
        assert_eq!(reloaded.get(&project.id).unwrap().display_name, "New Name");
    }

    #[test]
    fn rename_rejects_an_empty_display_name() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let project = registry
            .register("Repo".to_string(), local_source("/a"))
            .unwrap();

        let err = registry.rename(&project.id, "   ".to_string()).unwrap_err();
        assert!(err.contains("empty"), "err: {err}");
        assert_eq!(registry.get(&project.id).unwrap().display_name, "Repo");
    }

    #[test]
    fn rename_unknown_project_errs() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let err = registry.rename("nope", "New Name".to_string()).unwrap_err();
        assert!(err.contains("Unknown project"), "err: {err}");
    }

    #[test]
    fn remove_deletes_project_dir_and_registry_entry() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let project = registry
            .register("Repo".to_string(), local_source("/a"))
            .unwrap();
        let project_dir = registry.project_dir(&project.id);
        assert!(project_dir.exists());

        registry.remove(&project.id).unwrap();
        assert!(!project_dir.exists());
        assert!(registry.get(&project.id).is_none());
    }

    /// A project whose directory can't be deleted (e.g. a concurrent analyze
    /// job holding it open) must stay fully registered rather than vanishing
    /// from the in-memory map while its directory and a stale `registry.json`
    /// linger on disk — the split-brain state `remove`'s new ordering exists
    /// to prevent.
    #[test]
    #[cfg(unix)]
    fn remove_leaves_project_registered_when_directory_removal_fails() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(dir.path()).unwrap();
        let project = registry
            .register("Repo".to_string(), local_source("/a"))
            .unwrap();
        let project_dir = registry.project_dir(&project.id);

        // Removing a directory entry needs write access to its *parent*, not
        // the directory itself — strip write from `projects/` so
        // `remove_dir_all` on the child fails with a permission error.
        let parent = project_dir.parent().unwrap();
        let original_perms = fs::metadata(parent).unwrap().permissions();
        fs::set_permissions(parent, fs::Permissions::from_mode(0o555)).unwrap();

        let result = registry.remove(&project.id);

        // Restore before any assertion below can panic and skip cleanup.
        fs::set_permissions(parent, original_perms).unwrap();

        assert!(result.is_err(), "removal should fail without write access");
        assert!(project_dir.exists());
        assert!(
            registry.get(&project.id).is_some(),
            "project must stay registered when directory deletion fails"
        );
    }
}
