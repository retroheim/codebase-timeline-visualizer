import { LitElement, html, css } from 'lit';
import type { AnalysisRun, Project, ProjectSource, ProjectStatus, TimelineData } from '../types';

const POLL_INTERVAL_MS = 1200;
// ~3 minutes at POLL_INTERVAL_MS — long enough for a real large-repo clone
// and analyze, short enough that a genuinely stuck job (e.g. a hung git
// clone) doesn't poll forever with no way out for the user.
const MAX_POLL_ATTEMPTS = 150;

type SwitcherStatus = 'idle' | 'loading' | 'analyzing' | 'ready' | 'error';

/**
 * Registers projects (local path or git URL), and — via a dropdown panel,
 * not a cramped inline `<select>` — lists every known project with its own
 * status/source/last-analyzed time and per-project rename/refresh/delete
 * actions, so managing a project doesn't require first switching to it.
 * Owns its own idle -> analyzing -> ready -> error state machine for
 * *whichever* project is currently on screen, and talks to the
 * `/api/projects`/`/api/jobs` surface directly; the shell just listens for
 * `project-ready`/`project-error`.
 *
 * Analyzing status for the on-screen project is watched by re-polling
 * `GET /api/projects` (not a job id) so that resuming an already-in-flight
 * analysis after a page reload works the same way as watching one this
 * component just triggered. A background refresh of a project that *isn't*
 * on screen polls the same way but never touches `selectedId`/dispatches
 * `project-ready` — the row just updates in place.
 */
export class ProjectSwitcher extends LitElement {
  static properties = {
    initialProjectId: { attribute: false },
    projects: { state: true },
    selectedId: { state: true },
    status: { state: true },
    errorMessage: { state: true },
    panelOpen: { state: true },
    formOpen: { state: true },
    formKind: { state: true },
    formValue: { state: true },
    renamingId: { state: true },
    renameValue: { state: true },
    confirmDeleteId: { state: true },
    historyOpenId: { state: true },
    stalledIds: { state: true },
  };

  /** Project id to prefer selecting on first load, e.g. from the URL hash. */
  declare initialProjectId: string | null;
  declare projects: Project[];
  declare selectedId: string | null;
  declare status: SwitcherStatus;
  declare errorMessage: string | null;
  declare panelOpen: boolean;
  declare formOpen: boolean;
  declare formKind: 'path' | 'url';
  declare formValue: string;
  declare renamingId: string | null;
  declare renameValue: string;
  declare confirmDeleteId: string | null;
  declare historyOpenId: string | null;
  /** Background rows whose poll loop gave up (hit the attempt cap or an
   *  unrecoverable fetch error) — a client-side overlay independent of the
   *  server's own status, cleared the next time a refresh is triggered for
   *  that id. */
  declare stalledIds: Set<string>;

  private pollHandle: number | undefined;
  private backgroundPollHandles = new Map<string, number>();

  constructor() {
    super();
    this.initialProjectId = null;
    this.projects = [];
    this.selectedId = null;
    this.status = 'idle';
    this.errorMessage = null;
    this.panelOpen = false;
    this.formOpen = false;
    this.formKind = 'path';
    this.formValue = '';
    this.renamingId = null;
    this.renameValue = '';
    this.confirmDeleteId = null;
    this.historyOpenId = null;
    this.stalledIds = new Set();
  }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: var(--font-body, sans-serif);
      font-size: 12.5px;
      pointer-events: auto;
      position: relative;
    }
    button,
    input {
      font-family: inherit;
    }
    .chip {
      display: flex;
      align-items: center;
      gap: 7px;
      background: var(--panel, #0d1424);
      color: var(--paper, #e7edf5);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12.5px;
      max-width: 220px;
    }
    .chip:hover {
      border-color: rgba(255, 255, 255, 0.24);
    }
    .chip-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chevron {
      color: var(--mist, #55617a);
      font-size: 10px;
    }
    .dot {
      flex: none;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--mist, #55617a);
    }
    .dot.ready {
      background: var(--thread, #2fe6b8);
      box-shadow: 0 0 5px var(--thread, #2fe6b8);
    }
    .dot.error {
      background: var(--flare, #ff8a5c);
    }
    .dot.analyzing {
      background: var(--thread, #2fe6b8);
      animation: pulse 1s ease-in-out infinite;
    }
    .dot.stalled {
      background: var(--flare, #ff8a5c);
      box-shadow: 0 0 5px var(--flare, #ff8a5c);
    }
    @keyframes pulse {
      0%,
      100% {
        opacity: 0.3;
      }
      50% {
        opacity: 1;
      }
    }
    .status {
      font-family: var(--font-mono, monospace);
      font-size: 10.5px;
      color: var(--mist, #55617a);
      white-space: nowrap;
    }
    .status.error {
      color: var(--flare, #ff8a5c);
    }
    .icon-button {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      color: var(--mist, #55617a);
      cursor: pointer;
      padding: 4px 7px;
      font-size: 11px;
      line-height: 1;
    }
    .icon-button:hover:not(:disabled) {
      color: var(--paper, #e7edf5);
    }
    .icon-button:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .panel {
      position: absolute;
      top: 100%;
      left: 0;
      margin-top: 8px;
      width: 420px;
      max-height: 60vh;
      display: flex;
      flex-direction: column;
      border-radius: 12px;
      background: var(--panel, #0d1424);
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
      z-index: 10;
      overflow: hidden;
    }
    .panel-header {
      flex: none;
      padding: 12px 14px 8px;
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--mist, #55617a);
    }
    .panel-list {
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .empty-list {
      padding: 12px 14px 16px;
      color: var(--mist, #55617a);
      font-size: 12px;
    }
    .project-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }
    .project-row.current {
      background: rgba(47, 230, 184, 0.06);
    }
    .project-name {
      flex: 1;
      min-width: 0;
      background: none;
      border: none;
      color: var(--paper, #e7edf5);
      text-align: left;
      cursor: pointer;
      padding: 2px 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12.5px;
    }
    .project-name:hover {
      color: var(--thread, #2fe6b8);
    }
    .rename-input {
      flex: 1;
      min-width: 0;
      background: var(--void, #060810);
      color: var(--paper, #e7edf5);
      border: 1px solid var(--thread, #2fe6b8);
      border-radius: 5px;
      padding: 3px 6px;
      font-size: 12.5px;
    }
    .meta {
      flex: none;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 1px;
      font-family: var(--font-mono, monospace);
      font-size: 9.5px;
      color: var(--mist, #55617a);
      max-width: 120px;
    }
    .meta .source {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 120px;
    }
    .row-actions {
      flex: none;
      display: flex;
      gap: 4px;
    }
    .row-actions button.danger:hover {
      color: var(--flare, #ff8a5c);
      border-color: var(--flare, #ff8a5c);
    }
    .row-actions button.confirm {
      color: var(--flare, #ff8a5c);
      border-color: var(--flare, #ff8a5c);
    }
    .history-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 6px 14px 10px 29px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      background: rgba(255, 255, 255, 0.015);
    }
    .history-empty {
      padding: 8px 14px 10px 29px;
      color: var(--mist, #55617a);
      font-size: 11px;
      font-family: var(--font-mono, monospace);
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }
    .history-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-family: var(--font-mono, monospace);
      font-size: 10.5px;
      color: var(--mist, #55617a);
    }
    .history-outcome {
      flex: none;
      width: 12px;
    }
    .history-outcome.succeeded {
      color: var(--thread, #2fe6b8);
    }
    .history-outcome.failed {
      color: var(--flare, #ff8a5c);
    }
    .history-date {
      flex: none;
      color: var(--paper, #e7edf5);
    }
    .history-duration {
      flex: none;
    }
    .history-message {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--flare, #ff8a5c);
    }
    .panel-footer {
      flex: none;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding: 10px 14px;
    }
    .add-button {
      width: 100%;
      background: transparent;
      border: 1px dashed rgba(255, 255, 255, 0.18);
      border-radius: 7px;
      color: var(--mist, #55617a);
      padding: 7px;
      cursor: pointer;
      font-size: 12px;
    }
    .add-button:hover {
      color: var(--paper, #e7edf5);
      border-color: rgba(255, 255, 255, 0.32);
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .kind-toggle {
      display: flex;
      gap: 6px;
    }
    .kind-toggle label {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--mist, #55617a);
      cursor: pointer;
      font-size: 12px;
    }
    form input[type='text'] {
      background: var(--void, #060810);
      color: var(--paper, #e7edf5);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 6px 8px;
    }
    form button[type='submit'] {
      background: var(--flare, #ff8a5c);
      color: #1a0e08;
      border: none;
      border-radius: 6px;
      padding: 7px 10px;
      cursor: pointer;
      font-weight: 600;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.loadProjects();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopPolling();
    for (const handle of this.backgroundPollHandles.values()) window.clearTimeout(handle);
    this.backgroundPollHandles.clear();
  }

  private stopPolling(): void {
    if (this.pollHandle !== undefined) {
      window.clearTimeout(this.pollHandle);
      this.pollHandle = undefined;
    }
  }

  private async loadProjects(): Promise<void> {
    try {
      const response = await fetch('/api/projects');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.projects = await response.json();

      if (!this.selectedId) {
        const preferred = this.initialProjectId ? this.projects.find((p) => p.id === this.initialProjectId) : undefined;
        if (preferred) {
          // Always honor an explicit URL-selected project, whatever its
          // status — falling back to an unrelated ready project when this
          // one is `error` would silently redirect the user away from the
          // project they asked for with no explanation.
          void this.selectProject(preferred.id);
        } else {
          const ready = this.projects.find((p) => p.status.state === 'ready');
          const analyzing = this.projects.find((p) => p.status.state === 'analyzing');
          if (ready) void this.selectProject(ready.id);
          else if (analyzing) this.watchProject(analyzing.id);
        }
      }
    } catch (error) {
      console.warn('Could not load project list:', error);
    }
  }

  private async selectProject(id: string): Promise<void> {
    this.stopPolling();
    this.selectedId = id;
    const project = this.projects.find((p) => p.id === id);
    if (!project) return;

    if (project.status.state === 'ready') {
      await this.loadTimeline(id);
    } else if (project.status.state === 'analyzing') {
      this.watchProject(id);
    } else if (project.status.state === 'error') {
      this.setError(project.status.message);
    } else {
      this.status = 'idle';
    }
  }

  private selectAndClosePanel(id: string): void {
    this.panelOpen = false;
    void this.selectProject(id);
  }

  private async loadTimeline(id: string): Promise<void> {
    this.status = 'loading';
    try {
      const response = await fetch(`/api/projects/${id}/timeline`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: TimelineData = await response.json();
      this.status = 'ready';
      this.dispatchEvent(
        new CustomEvent('project-ready', { detail: { projectId: id, data }, bubbles: true, composed: true })
      );
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    }
  }

  private watchProject(id: string): void {
    this.selectedId = id;
    this.status = 'analyzing';
    this.errorMessage = null;
    this.poll(id);
  }

  private poll(id: string, attempt = 0): void {
    if (attempt >= MAX_POLL_ATTEMPTS) {
      this.setError('Analyze is taking longer than expected — it may be stuck. Try refreshing.');
      return;
    }
    this.pollHandle = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/projects');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.projects = await response.json();
        const project = this.projects.find((p) => p.id === id);
        if (!project) {
          this.setError('Project no longer exists');
          return;
        }
        if (project.status.state === 'ready') {
          await this.loadTimeline(id);
          return;
        }
        if (project.status.state === 'error') {
          this.setError(project.status.message);
          return;
        }
        this.poll(id, attempt + 1);
      } catch (error) {
        this.setError(error instanceof Error ? error.message : String(error));
      }
    }, POLL_INTERVAL_MS);
  }

  private setError(message: string): void {
    this.status = 'error';
    this.errorMessage = message;
    this.dispatchEvent(new CustomEvent('project-error', { detail: { message }, bubbles: true, composed: true }));
  }

  private async triggerAnalyze(id: string): Promise<void> {
    this.watchProject(id);
    try {
      const response = await fetch(`/api/projects/${id}/analyze`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      // Job accepted — the poll loop `watchProject` already started picks up completion.
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Refresh triggered from a project row that isn't the one on screen —
   *  polls the same way `watchProject`/`poll` do, but only ever updates
   *  `this.projects` (so the row's own status badge moves), never touches
   *  `selectedId`/`status` or dispatches `project-ready` for a project the
   *  user isn't looking at. */
  private async backgroundRefresh(id: string): Promise<void> {
    if (id === this.selectedId) {
      await this.triggerAnalyze(id);
      return;
    }
    this.clearStalled(id);
    try {
      const response = await fetch(`/api/projects/${id}/analyze`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const listResponse = await fetch('/api/projects');
      if (listResponse.ok) this.projects = await listResponse.json();
      this.pollBackground(id);
    } catch (error) {
      console.warn(`Could not refresh ${id}:`, error);
      this.markStalled(id);
    }
  }

  private markStalled(id: string): void {
    this.stalledIds = new Set(this.stalledIds).add(id);
  }

  private clearStalled(id: string): void {
    if (!this.stalledIds.has(id)) return;
    const next = new Set(this.stalledIds);
    next.delete(id);
    this.stalledIds = next;
  }

  private pollBackground(id: string, attempt = 0): void {
    const existing = this.backgroundPollHandles.get(id);
    if (existing !== undefined) window.clearTimeout(existing);

    if (attempt >= MAX_POLL_ATTEMPTS) {
      this.backgroundPollHandles.delete(id);
      this.markStalled(id);
      return;
    }

    const handle = window.setTimeout(async () => {
      this.backgroundPollHandles.delete(id);
      try {
        const response = await fetch('/api/projects');
        if (!response.ok) {
          this.markStalled(id);
          return;
        }
        this.projects = await response.json();
        const project = this.projects.find((p) => p.id === id);
        if (project?.status.state === 'analyzing') {
          this.pollBackground(id, attempt + 1);
        }
      } catch {
        // A real, not-merely-transient failure: a single fetch reject
        // deserves one retry's worth of benefit of the doubt, but silently
        // stopping forever with no visible state change is the bug this
        // fixes — mark the row stalled so the user can see and retry.
        this.markStalled(id);
      }
    }, POLL_INTERVAL_MS);
    this.backgroundPollHandles.set(id, handle);
  }

  private startRename(project: Project): void {
    this.confirmDeleteId = null;
    this.renamingId = project.id;
    this.renameValue = project.display_name;
  }

  private async submitRename(id: string): Promise<void> {
    const name = this.renameValue.trim();
    this.renamingId = null;
    if (!name) return;
    try {
      const response = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(err.error ?? `HTTP ${response.status}`);
      }
      const updated: Project = await response.json();
      this.projects = this.projects.map((p) => (p.id === id ? updated : p));
    } catch (error) {
      console.warn(`Could not rename ${id}:`, error);
    }
  }

  private async confirmDelete(id: string): Promise<void> {
    this.confirmDeleteId = null;
    try {
      const response = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.projects = this.projects.filter((p) => p.id !== id);
      if (id === this.selectedId) {
        this.stopPolling();
        this.selectedId = null;
        this.status = 'idle';
      }
    } catch (error) {
      console.warn(`Could not delete ${id}:`, error);
    }
  }

  private toggleHistory(id: string): void {
    this.historyOpenId = this.historyOpenId === id ? null : id;
  }

  private handleFormValue = (event: Event): void => {
    this.formValue = (event.target as HTMLInputElement).value;
  };

  private async submitForm(event: Event): Promise<void> {
    event.preventDefault();
    const value = this.formValue.trim();
    if (!value) return;

    const body = this.formKind === 'path' ? { path: value } : { url: value };
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(err.error ?? `HTTP ${response.status}`);
      }
      const project: Project = await response.json();
      this.projects = [...this.projects, project];
      this.formOpen = false;
      this.formValue = '';
      await this.triggerAnalyze(project.id);
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    }
  }

  private statusLabel(): string {
    switch (this.status) {
      case 'analyzing':
        return 'Analyzing…';
      case 'loading':
        return 'Loading…';
      case 'error':
        return this.errorMessage ?? 'Error';
      case 'ready':
        return '';
      default:
        return this.projects.length === 0 ? 'No projects yet' : 'No project selected';
    }
  }

  private statusDotClass(status: ProjectStatus): string {
    return status.state;
  }

  private sourceLabel(source: ProjectSource): string {
    return source.kind === 'local_path' ? source.path : source.url;
  }

  private lastAnalyzedLabel(project: Project): string {
    if (project.last_analyzed === null) return 'never analyzed';
    return new Date(project.last_analyzed * 1000).toLocaleDateString();
  }

  private runDuration(run: AnalysisRun): string {
    const seconds = Math.max(0, run.finished_at - run.started_at);
    if (seconds < 1) return '<1s';
    if (seconds < 60) return `${seconds}s`;
    return `${Math.round(seconds / 60)}m`;
  }

  render() {
    const current = this.projects.find((p) => p.id === this.selectedId);
    const busy = this.status === 'analyzing' || this.status === 'loading';

    return html`
      <button class="chip" @click=${() => (this.panelOpen = !this.panelOpen)} aria-expanded=${this.panelOpen}>
        <span class="dot ${current ? this.statusDotClass(current.status) : ''}"></span>
        <span class="chip-name">${current?.display_name ?? 'Select a project'}</span>
        <span class="chevron">${this.panelOpen ? '▴' : '▾'}</span>
      </button>

      ${current && current.status.state === 'ready'
        ? html`<button class="icon-button" title="Refresh (re-analyze)" ?disabled=${busy} @click=${() => this.backgroundRefresh(current.id)}>
            ↻
          </button>`
        : null}

      ${this.statusLabel()
        ? html`<span class="status ${this.status === 'error' ? 'error' : ''}">${this.statusLabel()}</span>`
        : null}

      ${this.panelOpen ? this.renderPanel() : null}
    `;
  }

  private renderPanel() {
    return html`
      <div class="panel">
        <div class="panel-header">Projects</div>
        <div class="panel-list">
          ${this.projects.length === 0
            ? html`<div class="empty-list">No projects registered yet.</div>`
            : this.projects.map((p) => this.renderProjectRow(p))}
        </div>
        <div class="panel-footer">
          ${this.formOpen ? this.renderForm() : html`<button class="add-button" @click=${() => (this.formOpen = true)}>+ Add project</button>`}
        </div>
      </div>
    `;
  }

  private renderProjectRow(project: Project) {
    const isRenaming = this.renamingId === project.id;
    const isConfirmingDelete = this.confirmDeleteId === project.id;
    const isHistoryOpen = this.historyOpenId === project.id;
    const isStalled = this.stalledIds.has(project.id);

    const row = html`
      <div class="project-row ${project.id === this.selectedId ? 'current' : ''}" data-project-id=${project.id}>
        <span
          class="dot ${isStalled ? 'stalled' : this.statusDotClass(project.status)}"
          title=${isStalled ? 'stalled — refresh to retry' : project.status.state}
        ></span>
        ${isRenaming
          ? html`<input
              class="rename-input"
              .value=${this.renameValue}
              @input=${(e: Event) => (this.renameValue = (e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') void this.submitRename(project.id);
                if (e.key === 'Escape') this.renamingId = null;
              }}
              @blur=${() => this.submitRename(project.id)}
            />`
          : html`<button class="project-name" @click=${() => this.selectAndClosePanel(project.id)}>${project.display_name}</button>`}
        <span class="meta">
          <span class="source">${this.sourceLabel(project.source)}</span>
          <span>${this.lastAnalyzedLabel(project)}</span>
        </span>
        <span class="row-actions">
          ${isConfirmingDelete
            ? html`
                <button class="icon-button confirm" title="Confirm delete" @click=${() => this.confirmDelete(project.id)}>Delete?</button>
                <button class="icon-button" title="Cancel" @click=${() => (this.confirmDeleteId = null)}>✕</button>
              `
            : html`
                <button
                  class="icon-button"
                  title="History"
                  aria-expanded=${isHistoryOpen}
                  @click=${() => this.toggleHistory(project.id)}
                >
                  🕘
                </button>
                <button class="icon-button" title="Rename" @click=${() => this.startRename(project)}>✎</button>
                <button
                  class="icon-button"
                  title="Refresh (re-analyze)"
                  ?disabled=${project.status.state === 'analyzing'}
                  @click=${() => this.backgroundRefresh(project.id)}
                >
                  ↻
                </button>
                <button class="icon-button danger" title="Delete" @click=${() => (this.confirmDeleteId = project.id)}>🗑</button>
              `}
        </span>
      </div>
    `;

    return [row, isHistoryOpen ? this.renderHistory(project) : null];
  }

  private renderHistory(project: Project) {
    if (project.history.length === 0) {
      return html`<div class="history-empty">No analyze runs yet.</div>`;
    }
    return html`
      <div class="history-list">
        ${project.history.map(
          (run) => html`
            <div class="history-row">
              <span class="history-outcome ${run.outcome.state}">${run.outcome.state === 'succeeded' ? '✓' : '✕'}</span>
              <span class="history-date">${new Date(run.finished_at * 1000).toLocaleString()}</span>
              <span class="history-duration">${this.runDuration(run)}</span>
              ${run.outcome.state === 'failed' ? html`<span class="history-message">${run.outcome.message}</span>` : null}
            </div>
          `
        )}
      </div>
    `;
  }

  private renderForm() {
    return html`
      <form @submit=${this.submitForm}>
        <div class="kind-toggle">
          <label><input type="radio" name="kind" ?checked=${this.formKind === 'path'} @change=${() => (this.formKind = 'path')} /> Local path</label>
          <label><input type="radio" name="kind" ?checked=${this.formKind === 'url'} @change=${() => (this.formKind = 'url')} /> Git URL</label>
        </div>
        <input
          type="text"
          placeholder=${this.formKind === 'path' ? '/path/to/repo' : 'https://github.com/owner/repo.git'}
          .value=${this.formValue}
          @input=${this.handleFormValue}
        />
        <button type="submit">Register &amp; analyze</button>
      </form>
    `;
  }
}

customElements.define('project-switcher', ProjectSwitcher);

declare global {
  interface HTMLElementTagNameMap {
    'project-switcher': ProjectSwitcher;
  }
}
