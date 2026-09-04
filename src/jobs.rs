//! In-memory tracking for in-flight analyze jobs. Deliberately not
//! persisted: `Registry`'s `status`/`last_analyzed` fields are the durable
//! record of a project's state, so a job entry only needs to exist long
//! enough for the frontend to poll it while the job is running. Losing job
//! history on restart is fine — `Registry::load` already downgrades any
//! project stuck `Analyzing` to `Error`, which is the state that matters.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum JobState {
    Running,
    Succeeded,
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct Job {
    pub id: String,
    pub project_id: String,
    pub state: JobState,
}

#[derive(Default)]
pub struct JobManager {
    // Every critical section here is a plain map read/insert with no
    // `.await` inside it, so a stdlib `Mutex` is correct — no need to add
    // tokio's `sync` feature for an async-aware one.
    jobs: Mutex<HashMap<String, Job>>,
    next_id: Mutex<u64>,
}

impl JobManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&self, project_id: String) -> String {
        let job_id = {
            let mut next_id = self.next_id.lock().unwrap();
            let id = format!("job-{}", *next_id);
            *next_id += 1;
            id
        };
        self.jobs.lock().unwrap().insert(
            job_id.clone(),
            Job {
                id: job_id.clone(),
                project_id,
                state: JobState::Running,
            },
        );
        job_id
    }

    pub fn finish(&self, job_id: &str, result: Result<(), String>) {
        if let Some(job) = self.jobs.lock().unwrap().get_mut(job_id) {
            job.state = match result {
                Ok(()) => JobState::Succeeded,
                Err(message) => JobState::Failed { message },
            };
        }
    }

    pub fn get(&self, job_id: &str) -> Option<Job> {
        self.jobs.lock().unwrap().get(job_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_then_get_reports_running() {
        let jobs = JobManager::new();
        let id = jobs.start("proj-a".to_string());
        let job = jobs.get(&id).unwrap();
        assert_eq!(job.state, JobState::Running);
        assert_eq!(job.project_id, "proj-a");
    }

    #[test]
    fn finish_ok_reports_succeeded() {
        let jobs = JobManager::new();
        let id = jobs.start("proj-a".to_string());
        jobs.finish(&id, Ok(()));
        assert_eq!(jobs.get(&id).unwrap().state, JobState::Succeeded);
    }

    #[test]
    fn finish_err_reports_failed_with_message() {
        let jobs = JobManager::new();
        let id = jobs.start("proj-a".to_string());
        jobs.finish(&id, Err("clone failed".to_string()));
        assert_eq!(
            jobs.get(&id).unwrap().state,
            JobState::Failed {
                message: "clone failed".to_string()
            }
        );
    }

    #[test]
    fn distinct_jobs_get_distinct_ids() {
        let jobs = JobManager::new();
        let a = jobs.start("proj-a".to_string());
        let b = jobs.start("proj-b".to_string());
        assert_ne!(a, b);
    }

    #[test]
    fn unknown_job_id_returns_none() {
        let jobs = JobManager::new();
        assert!(jobs.get("nope").is_none());
    }
}
