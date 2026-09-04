mod analyzer;
mod exporter;
mod git_source;
mod github;
mod jobs;
mod pipeline;
mod projects_api;
mod registry;
mod server;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "codevis",
    version = "1.0.0",
    about = "Codebase Timeline Visualizer - Make Git history visual and interactive."
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Analyze a Git repository and generate timeline data.
    Analyze {
        repo_path: PathBuf,
        #[arg(short, long, default_value = "timeline.json")]
        output: PathBuf,
        #[arg(short, long)]
        verbose: bool,
    },
    /// Start the web interface server.
    Serve {
        #[arg(short, long, default_value_t = 3001)]
        port: u16,
        /// Interface to bind. Defaults to loopback: the served timeline(s)
        /// contain full commit history, author names and email addresses, so
        /// exposing it to the network is opt-in. Pass `--host 0.0.0.0` to
        /// serve other machines (or a container's published port).
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Legacy single-file mode: serve exactly this timeline.json (only
        /// `/api/timeline`, no project registry). Omit to use multi-project
        /// mode instead.
        #[arg(short, long)]
        data: Option<PathBuf>,
        /// Multi-project mode: directory holding the project registry and
        /// each project's analyzed data. Ignored if `--data` is passed.
        #[arg(long, default_value = "codevis-data")]
        data_dir: PathBuf,
    },
    /// Export a timeline JSON file as a standalone visualization.
    Export {
        data_file: PathBuf,
        #[arg(short, long, default_value = "html")]
        format: String,
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Directory holding the built frontend that gets inlined.
        #[arg(long, default_value = "frontend/build")]
        frontend_build: PathBuf,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Analyze {
            repo_path,
            output,
            verbose,
        } => run_analyze(&repo_path, &output, verbose),
        Commands::Serve {
            port,
            host,
            data,
            data_dir,
        } => run_serve(&host, port, data, data_dir),
        Commands::Export {
            data_file,
            format,
            output,
            frontend_build,
        } => run_export(&data_file, &format, output, &frontend_build),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run_analyze(repo_path: &Path, output: &Path, verbose: bool) -> Result<(), String> {
    let timeline_data = pipeline::analyze_repository(repo_path, verbose)?;

    exporter::export_json(&timeline_data, output)?;

    if verbose {
        println!("Analysis complete!");
        println!(
            "  - Total commits: {}",
            timeline_data.metadata.total_commits
        );
        println!(
            "  - Total contributors: {}",
            timeline_data.metadata.total_contributors
        );
        println!("  - Total files: {}", timeline_data.metadata.total_files);
    } else {
        println!(
            "Repository analyzed successfully. Data saved to {}",
            output.display()
        );
    }

    Ok(())
}

fn run_serve(
    host: &str,
    port: u16,
    data: Option<PathBuf>,
    data_dir: PathBuf,
) -> Result<(), String> {
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    match data {
        Some(data_path) => rt.block_on(server::run(host, port, data_path)),
        None => {
            bootstrap_import_if_needed(&data_dir, Path::new("timeline.json"))?;
            rt.block_on(server::run_multi_project(host, port, data_dir))
        }
    }
}

/// One-time migration: if this is the first time `data_dir` is created and a
/// legacy `timeline.json` already exists in the working directory, import it
/// as the first project so upgrading from single-file mode doesn't lose
/// visibility into data that's already been analyzed. Best-guess source is
/// the current directory — the original repo path isn't recorded anywhere in
/// `timeline.json` itself, but `analyze .` in the cwd is by far the most
/// common way that file got there.
///
/// `legacy_timeline` is a parameter (rather than a hardcoded relative path)
/// so tests can point it at a fixture without touching the process's actual
/// working directory — `std::env::set_current_dir` is process-global and
/// would race `cargo test`'s parallel test threads.
fn bootstrap_import_if_needed(data_dir: &Path, legacy_timeline: &Path) -> Result<(), String> {
    if data_dir.exists() {
        return Ok(());
    }
    if !legacy_timeline.exists() {
        return Ok(());
    }

    let raw = fs::read_to_string(legacy_timeline)
        .map_err(|e| format!("Could not read {}: {e}", legacy_timeline.display()))?;
    let repo_name = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| {
            v.get("metadata")?
                .get("repo_name")?
                .as_str()
                .map(|s| s.to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "imported-project".to_string());

    println!(
        "Found existing {} - importing as project '{repo_name}' into {}",
        legacy_timeline.display(),
        data_dir.display()
    );

    let mut registry = registry::Registry::load(data_dir)?;
    registry.register_ready(
        repo_name,
        registry::ProjectSource::LocalPath {
            path: ".".to_string(),
        },
        legacy_timeline,
    )?;
    Ok(())
}

fn run_export(
    data_file: &Path,
    format: &str,
    output: Option<PathBuf>,
    frontend_build: &Path,
) -> Result<(), String> {
    if !data_file.exists() {
        return Err(format!("Data file does not exist: {}", data_file.display()));
    }
    if format != "html" {
        return Err(format!(
            "Unsupported export format: {format}. Supported formats: html"
        ));
    }

    let output = output.unwrap_or_else(|| {
        let stem = data_file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("timeline");
        PathBuf::from(format!("{stem}_timeline.{format}"))
    });

    // Pass the file's bytes through rather than deserializing and re-emitting:
    // export should reproduce exactly what `analyze` wrote, including data from
    // a schema version this build may not know about.
    let timeline_json = fs::read_to_string(data_file)
        .map_err(|e| format!("Could not read {}: {e}", data_file.display()))?;

    exporter::export_html(&timeline_json, frontend_build, &output)?;

    println!("Exported {} to {}", data_file.display(), output.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn does_nothing_when_data_dir_already_exists() {
        let dir = TempDir::new().unwrap();
        let data_dir = dir.path().join("data");
        fs::create_dir(&data_dir).unwrap();
        let legacy = dir.path().join("timeline.json");
        fs::write(&legacy, r#"{"metadata":{"repo_name":"should-not-import"}}"#).unwrap();

        bootstrap_import_if_needed(&data_dir, &legacy).unwrap();

        assert!(!data_dir.join("registry.json").exists());
    }

    #[test]
    fn does_nothing_when_legacy_timeline_is_absent() {
        let dir = TempDir::new().unwrap();
        let data_dir = dir.path().join("data");
        let legacy = dir.path().join("timeline.json");

        bootstrap_import_if_needed(&data_dir, &legacy).unwrap();

        assert!(!data_dir.exists());
    }

    #[test]
    fn imports_the_legacy_timeline_as_a_ready_project() {
        let dir = TempDir::new().unwrap();
        let data_dir = dir.path().join("data");
        let legacy = dir.path().join("timeline.json");
        fs::write(&legacy, r#"{"metadata":{"repo_name":"my-repo"}}"#).unwrap();

        bootstrap_import_if_needed(&data_dir, &legacy).unwrap();

        let registry = registry::Registry::load(&data_dir).unwrap();
        let projects = registry.list();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].display_name, "my-repo");
        assert_eq!(projects[0].status, registry::ProjectStatus::Ready);
    }

    #[test]
    fn falls_back_to_a_generic_name_for_malformed_json() {
        let dir = TempDir::new().unwrap();
        let data_dir = dir.path().join("data");
        let legacy = dir.path().join("timeline.json");
        fs::write(&legacy, "not json at all").unwrap();

        bootstrap_import_if_needed(&data_dir, &legacy).unwrap();

        let registry = registry::Registry::load(&data_dir).unwrap();
        assert_eq!(registry.list()[0].display_name, "imported-project");
    }
}
