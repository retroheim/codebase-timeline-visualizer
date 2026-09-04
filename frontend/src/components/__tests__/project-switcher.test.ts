import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../project-switcher';
import type { ProjectSwitcher } from '../project-switcher';
import type { Project, TimelineData } from '../../types';
import { mount, unmount } from './fixtures';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'my-repo',
    display_name: 'my-repo',
    source: { kind: 'local_path', path: '/tmp/my-repo' },
    status: { state: 'ready' },
    last_analyzed: 1700000000,
    history: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function tinyTimeline(): TimelineData {
  return {
    metadata: {
      schema_version: 1,
      repo_name: 'my-repo',
      github_repo: null,
      total_commits: 1,
      total_contributors: 1,
      total_files: 1,
      date_range: { start: null, end: null },
    },
    timeline: [],
    contributors: {},
    files: {},
  };
}

function openPanel(el: ProjectSwitcher): Promise<void> {
  const chip = el.shadowRoot!.querySelector('.chip') as HTMLButtonElement;
  chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return el.updateComplete as unknown as Promise<void>;
}

function row(el: ProjectSwitcher, id: string): HTMLElement {
  const found = el.shadowRoot!.querySelector(`.project-row[data-project-id="${id}"]`);
  if (!found) throw new Error(`no row for ${id}`);
  return found as HTMLElement;
}

function rowButton(el: ProjectSwitcher, id: string, title: string): HTMLButtonElement {
  const found = row(el, id).querySelector(`button[title="${title}"]`);
  if (!found) throw new Error(`no ${title} button for ${id}`);
  return found as HTMLButtonElement;
}

describe('project-switcher', () => {
  let el: ProjectSwitcher | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    if (el) unmount(el);
    el = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lists projects returned by GET /api/projects and auto-loads the ready one', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project()]));
      if (url === '/api/projects/my-repo/timeline') return Promise.resolve(jsonResponse(tinyTimeline()));
      throw new Error(`unexpected fetch ${url}`);
    });

    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.selectedId).toBe('my-repo'));
    expect(el.shadowRoot?.querySelector('.chip-name')?.textContent).toBe('my-repo');

    await openPanel(el);
    expect(row(el, 'my-repo')).not.toBeNull();
  });

  it('dispatches project-ready once the auto-selected project loads', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project()]));
      if (url === '/api/projects/my-repo/timeline') return Promise.resolve(jsonResponse(tinyTimeline()));
      throw new Error(`unexpected fetch ${url}`);
    });

    const readyEvents: unknown[] = [];
    const target = document.createElement('project-switcher') as ProjectSwitcher;
    target.addEventListener('project-ready', (e) => readyEvents.push((e as CustomEvent).detail));
    document.body.appendChild(target);
    el = target;
    await el.updateComplete;

    await vi.waitFor(() => expect(readyEvents).toHaveLength(1));
    expect((readyEvents[0] as { projectId: string }).projectId).toBe('my-repo');
  });

  it('registering a new project posts create then analyze, and polls until ready', async () => {
    let projectsState: Project[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && (!init || init.method === undefined)) {
        return Promise.resolve(jsonResponse(projectsState));
      }
      if (url === '/api/projects' && init?.method === 'POST') {
        const created = project({ status: { state: 'never_analyzed' } });
        projectsState = [created];
        return Promise.resolve(jsonResponse(created, true, 201));
      }
      if (url === '/api/projects/my-repo/analyze') {
        projectsState = [project({ status: { state: 'analyzing' } })];
        return Promise.resolve(jsonResponse({ job_id: 'job-0' }, true, 202));
      }
      if (url === '/api/projects/my-repo/timeline') {
        return Promise.resolve(jsonResponse(tinyTimeline()));
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    el = await mount<ProjectSwitcher>('project-switcher');
    const readyEvents: unknown[] = [];
    el.addEventListener('project-ready', (e) => readyEvents.push((e as CustomEvent).detail));

    await openPanel(el);
    const addButton = el.shadowRoot!.querySelector('.add-button') as HTMLButtonElement;
    addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    const input = el.shadowRoot?.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = '/tmp/my-repo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;

    const form = el.shadowRoot?.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(el!.status).toBe('analyzing'));

    // First poll tick finds the project now ready.
    projectsState = [project({ status: { state: 'ready' } })];
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(readyEvents).toHaveLength(1));
  });

  it('surfaces an error status and dispatches project-error when a project failed', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') {
        return Promise.resolve(jsonResponse([project({ status: { state: 'error', message: 'boom' } })]));
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const errorEvents: unknown[] = [];
    const target = document.createElement('project-switcher') as ProjectSwitcher;
    target.addEventListener('project-error', (e) => errorEvents.push((e as CustomEvent).detail));
    document.body.appendChild(target);
    el = target;
    await el.updateComplete;
    // An errored project isn't auto-selected — select it by hand, same as a
    // user clicking it in the panel.
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    await openPanel(el);
    row(el, 'my-repo').querySelector('.project-name')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => expect(errorEvents).toHaveLength(1));
    expect((errorEvents[0] as { message: string }).message).toBe('boom');
    expect(el.shadowRoot?.textContent).toContain('boom');
  });

  it('warns without crashing when GET /api/projects rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.reject(new Error('offline'));
      throw new Error(`unexpected fetch ${url}`);
    });

    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('warns without crashing when GET /api/projects responds with a non-ok status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse(null, false, 500));
      throw new Error(`unexpected fetch ${url}`);
    });

    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('prefers initialProjectId over an unrelated analyzing project when neither is ready', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') {
        return Promise.resolve(
          jsonResponse([
            // Listed first, but not the preferred id — the component should
            // still land on `target`, not just "the first analyzing one".
            project({ id: 'other', display_name: 'other', status: { state: 'analyzing' } }),
            project({ id: 'target', display_name: 'target', status: { state: 'analyzing' } }),
          ])
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    el = await mount<ProjectSwitcher>('project-switcher', { initialProjectId: 'target' } as Partial<ProjectSwitcher>);
    await vi.waitFor(() => expect(el!.status).toBe('analyzing'));
    expect(el.selectedId).toBe('target');
  });

  it('surfaces an initialProjectId in error state instead of silently substituting an unrelated ready project', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') {
        return Promise.resolve(
          jsonResponse([
            project({ id: 'ready-one', display_name: 'ready-one' }),
            project({ id: 'target', display_name: 'target', status: { state: 'error', message: 'clone failed' } }),
          ])
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const errorEvents: unknown[] = [];
    const target = document.createElement('project-switcher') as ProjectSwitcher;
    target.initialProjectId = 'target';
    target.addEventListener('project-error', (e) => errorEvents.push((e as CustomEvent).detail));
    document.body.appendChild(target);
    el = target;

    await vi.waitFor(() => expect(errorEvents).toHaveLength(1));
    expect((errorEvents[0] as { message: string }).message).toBe('clone failed');
    expect(el.selectedId).toBe('target');
    expect(el.status).toBe('error');
  });

  it('selecting an unknown project id is a no-op', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));

    // Exercises the "project not found" guard directly — no row exists for
    // an id that was never in the list, so this can't be reached by click.
    await (el as unknown as { selectProject(id: string): Promise<void> }).selectProject('does-not-exist');
    expect(el.status).toBe('idle');
  });

  it('selecting a never-analyzed project sets status to idle', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));

    await openPanel(el);
    row(el, 'my-repo').querySelector('.project-name')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(el.status).toBe('idle');
  });

  it('manually selecting an already-analyzing project resumes watching it', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') {
        return Promise.resolve(
          jsonResponse([
            project({ id: 'ready-one', display_name: 'ready-one' }),
            project({ id: 'in-progress', display_name: 'in-progress', status: { state: 'analyzing' } }),
          ])
        );
      }
      if (url === '/api/projects/ready-one/timeline') return Promise.resolve(jsonResponse(tinyTimeline()));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    // Auto-select picks the ready project first.
    await vi.waitFor(() => expect(el!.selectedId).toBe('ready-one'));

    await openPanel(el);
    row(el, 'in-progress').querySelector('.project-name')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(el.status).toBe('analyzing');
    expect(el.selectedId).toBe('in-progress');
  });

  it('warns and reports an error when a ready project fails to load its timeline', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project()]));
      if (url === '/api/projects/my-repo/timeline') return Promise.resolve(jsonResponse(null, false, 404));
      throw new Error(`unexpected fetch ${url}`);
    });
    const errorEvents: unknown[] = [];
    const target = document.createElement('project-switcher') as ProjectSwitcher;
    target.addEventListener('project-error', (e) => errorEvents.push((e as CustomEvent).detail));
    document.body.appendChild(target);
    el = target;

    await vi.waitFor(() => expect(errorEvents).toHaveLength(1));
    expect(el.status).toBe('error');
  });

  it('poll loop surfaces an error when GET /api/projects fails mid-poll', async () => {
    let pollCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && !init) {
        pollCount += 1;
        // First call (initial list) succeeds; the poll tick after triggering
        // analyze fails.
        if (pollCount === 1) return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
        return Promise.resolve(jsonResponse(null, false, 502));
      }
      if (url === '/api/projects/my-repo/analyze') return Promise.resolve(jsonResponse({ job_id: 'job-0' }, true, 202));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    await (el as unknown as { triggerAnalyze(id: string): Promise<void> }).triggerAnalyze('my-repo');

    await vi.advanceTimersByTimeAsync(1500);
    expect(el.status).toBe('error');
  });

  it('poll loop reports an error when the project disappears mid-poll', async () => {
    let pollCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && !init) {
        pollCount += 1;
        if (pollCount === 1) return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
        return Promise.resolve(jsonResponse([])); // project removed by someone else
      }
      if (url === '/api/projects/my-repo/analyze') return Promise.resolve(jsonResponse({ job_id: 'job-0' }, true, 202));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    await (el as unknown as { triggerAnalyze(id: string): Promise<void> }).triggerAnalyze('my-repo');

    await vi.advanceTimersByTimeAsync(1500);
    expect(el.status).toBe('error');
    expect(el.errorMessage).toContain('no longer exists');
  });

  it('poll loop stops and reports an error when the project transitions to error', async () => {
    let pollCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && !init) {
        pollCount += 1;
        if (pollCount === 1) return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
        return Promise.resolve(jsonResponse([project({ status: { state: 'error', message: 'analyze failed' } })]));
      }
      if (url === '/api/projects/my-repo/analyze') return Promise.resolve(jsonResponse({ job_id: 'job-0' }, true, 202));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    await (el as unknown as { triggerAnalyze(id: string): Promise<void> }).triggerAnalyze('my-repo');

    await vi.advanceTimersByTimeAsync(1500);
    expect(el.status).toBe('error');
    expect(el.errorMessage).toBe('analyze failed');
  });

  it('poll loop surfaces an error when the poll fetch itself throws', async () => {
    let pollCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && !init) {
        pollCount += 1;
        if (pollCount === 1) return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
        return Promise.reject(new Error('offline'));
      }
      if (url === '/api/projects/my-repo/analyze') return Promise.resolve(jsonResponse({ job_id: 'job-0' }, true, 202));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    await (el as unknown as { triggerAnalyze(id: string): Promise<void> }).triggerAnalyze('my-repo');

    await vi.advanceTimersByTimeAsync(1500);
    expect(el.status).toBe('error');
  });

  it('reports the server error message when triggering analyze fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
      if (url === '/api/projects/my-repo/analyze') {
        return Promise.resolve(jsonResponse({ error: 'already running' }, false, 409));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    await (el as unknown as { triggerAnalyze(id: string): Promise<void> }).triggerAnalyze('my-repo');

    expect(el.status).toBe('error');
    expect(el.errorMessage).toBe('already running');
  });

  it('does nothing when the new-project form is submitted with an empty value', async () => {
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toEqual([]));

    await openPanel(el);
    const addButton = el.shadowRoot!.querySelector('.add-button') as HTMLButtonElement;
    addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    const form = el.shadowRoot?.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await el.updateComplete;

    // No POST call was ever attempted — only the initial GET /api/projects.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects');
  });

  it('reports the server error message when registering a project fails', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && !init) return Promise.resolve(jsonResponse([]));
      if (url === '/api/projects' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ error: 'path must not be empty' }, false, 400));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toEqual([]));

    await openPanel(el);
    const addButton = el.shadowRoot!.querySelector('.add-button') as HTMLButtonElement;
    addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;
    const input = el.shadowRoot?.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = '/tmp/whatever';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;

    const form = el.shadowRoot?.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(el!.status).toBe('error'));
    expect(el.errorMessage).toBe('path must not be empty');
  });

  it('reports a network error when registering a project throws', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && !init) return Promise.resolve(jsonResponse([]));
      if (url === '/api/projects' && init?.method === 'POST') return Promise.reject(new Error('offline'));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toEqual([]));

    await openPanel(el);
    const addButton = el.shadowRoot!.querySelector('.add-button') as HTMLButtonElement;
    addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;
    const input = el.shadowRoot?.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = '/tmp/whatever';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;

    const form = el.shadowRoot?.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(el!.status).toBe('error'));
    expect(el.errorMessage).toBe('offline');
  });

  it('the local-path/git-url radio buttons toggle formKind', async () => {
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toEqual([]));
    await openPanel(el);
    const addButton = el.shadowRoot!.querySelector('.add-button') as HTMLButtonElement;
    addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    const radios = el.shadowRoot?.querySelectorAll('input[type="radio"]');
    expect(radios).toHaveLength(2);
    (radios![1] as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
    expect(el.formKind).toBe('url');

    (radios![0] as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
    expect(el.formKind).toBe('path');
  });

  it('renames a project via the panel and updates the row in place', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && (!init || init.method === undefined)) return Promise.resolve(jsonResponse([project()]));
      if (url === '/api/projects/my-repo/timeline') return Promise.resolve(jsonResponse(tinyTimeline()));
      if (url === '/api/projects/my-repo' && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string);
        return Promise.resolve(jsonResponse(project({ display_name: body.display_name })));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.selectedId).toBe('my-repo'));
    await openPanel(el);

    rowButton(el, 'my-repo', 'Rename').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;
    const input = row(el, 'my-repo').querySelector('.rename-input') as HTMLInputElement;
    input.value = 'renamed-repo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => expect(el!.projects[0].display_name).toBe('renamed-repo'));
    expect(el.renamingId).toBeNull();
  });

  it('cancels renaming on Escape without submitting', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    await openPanel(el);

    rowButton(el, 'my-repo', 'Rename').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;
    const input = row(el, 'my-repo').querySelector('.rename-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(el.renamingId).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deletes a project after confirming, and clears selection if it was selected', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && (!init || init.method === undefined)) return Promise.resolve(jsonResponse([project()]));
      if (url === '/api/projects/my-repo/timeline') return Promise.resolve(jsonResponse(tinyTimeline()));
      if (url === '/api/projects/my-repo' && init?.method === 'DELETE') return Promise.resolve(jsonResponse({}));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.selectedId).toBe('my-repo'));
    await openPanel(el);

    rowButton(el, 'my-repo', 'Delete').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;
    rowButton(el, 'my-repo', 'Confirm delete').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => expect(el!.projects).toHaveLength(0));
    expect(el.selectedId).toBeNull();
    expect(el.status).toBe('idle');
  });

  it('cancelling a delete leaves the project in place', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    await openPanel(el);

    rowButton(el, 'my-repo', 'Delete').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;
    rowButton(el, 'my-repo', 'Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    expect(el.projects).toHaveLength(1);
    expect(el.confirmDeleteId).toBeNull();
  });

  it('refreshing a non-selected project updates its row without touching the selected project', async () => {
    let projectsState = [
      project({ id: 'selected', display_name: 'selected' }),
      project({ id: 'other', display_name: 'other', status: { state: 'never_analyzed' } }),
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && (!init || init.method === undefined)) return Promise.resolve(jsonResponse(projectsState));
      if (url === '/api/projects/selected/timeline') return Promise.resolve(jsonResponse(tinyTimeline()));
      if (url === '/api/projects/other/analyze' && init?.method === 'POST') {
        projectsState = [projectsState[0], project({ id: 'other', display_name: 'other', status: { state: 'analyzing' } })];
        return Promise.resolve(jsonResponse({ job_id: 'job-0' }, true, 202));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.selectedId).toBe('selected'));
    await openPanel(el);

    rowButton(el, 'other', 'Refresh (re-analyze)').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(el!.projects.find((p) => p.id === 'other')?.status.state).toBe('analyzing'));

    // The on-screen project is untouched — no re-fetch of its timeline, no status change.
    expect(el.selectedId).toBe('selected');
    expect(el.status).toBe('ready');

    projectsState = [projectsState[0], project({ id: 'other', display_name: 'other', status: { state: 'ready' } })];
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(el!.projects.find((p) => p.id === 'other')?.status.state).toBe('ready'));
    // Still hasn't touched the selected project or dispatched anything for it.
    expect(el.selectedId).toBe('selected');
  });

  it('refreshing the currently-selected project uses the normal watch/poll flow', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && (!init || init.method === undefined)) return Promise.resolve(jsonResponse([project()]));
      if (url === '/api/projects/my-repo/timeline') return Promise.resolve(jsonResponse(tinyTimeline()));
      if (url === '/api/projects/my-repo/analyze' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ job_id: 'job-0' }, true, 202));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.status).toBe('ready'));
    await el.updateComplete;

    const refreshButton = el.shadowRoot!.querySelector('.icon-button') as HTMLButtonElement;
    refreshButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(el!.status).toBe('analyzing'));
  });

  it('toggles a project row\'s analyze history open and closed', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') {
        return Promise.resolve(
          jsonResponse([
            project({
              status: { state: 'never_analyzed' },
              history: [
                { started_at: 1700000000, finished_at: 1700000010, outcome: { state: 'succeeded' } },
                { started_at: 1699999000, finished_at: 1699999005, outcome: { state: 'failed', message: 'clone failed' } },
              ],
            }),
          ])
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    await openPanel(el);

    expect(el.shadowRoot!.querySelector('.history-list')).toBeNull();
    rowButton(el, 'my-repo', 'History').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    const historyRows = el.shadowRoot!.querySelectorAll('.history-row');
    expect(historyRows).toHaveLength(2);
    expect(historyRows[0].textContent).toContain('✓');
    expect(historyRows[1].textContent).toContain('clone failed');

    rowButton(el, 'my-repo', 'History').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.history-list')).toBeNull();
  });

  it('shows an empty-history message for a project with no runs yet', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    await openPanel(el);

    rowButton(el, 'my-repo', 'History').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.history-empty')?.textContent).toContain('No analyze runs yet');
  });

  it('poll() gives up after the attempt cap and surfaces a timeout error', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
      if (url === '/api/projects/my-repo/analyze') return Promise.resolve(jsonResponse({ job_id: 'job-0' }, true, 202));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    await (el as unknown as { triggerAnalyze(id: string): Promise<void> }).triggerAnalyze('my-repo');
    expect(el.status).toBe('analyzing');

    // The project never leaves 'never_analyzed' in this mock, so poll()
    // must give up after MAX_POLL_ATTEMPTS rather than recursing forever.
    await vi.advanceTimersByTimeAsync(1200 * 151);
    expect(el.status).toBe('error');
    expect(el.errorMessage).toContain('taking longer than expected');
  }, 20000);

  it('pollBackground() marks a row stalled after the attempt cap', async () => {
    let projectsState = [
      project({ id: 'selected', display_name: 'selected' }),
      project({ id: 'other', display_name: 'other', status: { state: 'never_analyzed' } }),
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && (!init || init.method === undefined)) return Promise.resolve(jsonResponse(projectsState));
      if (url === '/api/projects/selected/timeline') return Promise.resolve(jsonResponse(tinyTimeline()));
      if (url === '/api/projects/other/analyze' && init?.method === 'POST') {
        projectsState = [projectsState[0], project({ id: 'other', display_name: 'other', status: { state: 'analyzing' } })];
        return Promise.resolve(jsonResponse({ job_id: 'job-0' }, true, 202));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.selectedId).toBe('selected'));
    await openPanel(el);

    rowButton(el, 'other', 'Refresh (re-analyze)').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(el!.projects.find((p) => p.id === 'other')?.status.state).toBe('analyzing'));

    // 'other' stays 'analyzing' forever in this mock — pollBackground must
    // give up after the cap and mark the row stalled instead of polling
    // silently forever.
    await vi.advanceTimersByTimeAsync(1200 * 151);
    await el.updateComplete;
    const dot = row(el, 'other').querySelector('.dot');
    expect(dot?.classList.contains('stalled')).toBe(true);
    // The on-screen project must be completely unaffected.
    expect(el.selectedId).toBe('selected');
    expect(el.status).toBe('ready');
  }, 20000);

  it('pollBackground() marks a row stalled (not silently stuck) on a non-ok poll response', async () => {
    let pollCount = 0;
    let projectsState = [
      project({ id: 'selected', display_name: 'selected' }),
      project({ id: 'other', display_name: 'other', status: { state: 'never_analyzed' } }),
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && (!init || init.method === undefined)) {
        pollCount += 1;
        // 1st call: initial mount load. 2nd call: backgroundRefresh's
        // post-trigger list refresh. 3rd+ (the actual poll ticks): fail.
        if (pollCount <= 2) return Promise.resolve(jsonResponse(projectsState));
        return Promise.resolve(jsonResponse(null, false, 500));
      }
      if (url === '/api/projects/selected/timeline') return Promise.resolve(jsonResponse(tinyTimeline()));
      if (url === '/api/projects/other/analyze' && init?.method === 'POST') {
        projectsState = [projectsState[0], project({ id: 'other', display_name: 'other', status: { state: 'analyzing' } })];
        return Promise.resolve(jsonResponse({ job_id: 'job-0' }, true, 202));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.selectedId).toBe('selected'));
    await openPanel(el);

    rowButton(el, 'other', 'Refresh (re-analyze)').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Let backgroundRefresh's own POST + list-refresh GET (real, non-fake-timer
    // promises) settle before advancing the fake timer that drives the actual
    // poll tick.
    await vi.waitFor(() => expect(pollCount).toBeGreaterThanOrEqual(2));
    await vi.advanceTimersByTimeAsync(1200);
    await el.updateComplete;

    const dot = row(el, 'other').querySelector('.dot');
    expect(dot?.classList.contains('stalled')).toBe(true);
  });

  it('backgroundRefresh clears a previously-stalled row when retried', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && (!init || init.method === undefined)) return Promise.resolve(jsonResponse([project({ status: { state: 'never_analyzed' } })]));
      if (url === '/api/projects/my-repo/analyze' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ job_id: 'job-0' }, true, 202));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<ProjectSwitcher>('project-switcher');
    await vi.waitFor(() => expect(el!.projects).toHaveLength(1));
    (el as unknown as { stalledIds: Set<string> }).stalledIds = new Set(['my-repo']);
    await el.updateComplete;
    await openPanel(el);
    expect(row(el, 'my-repo').querySelector('.dot')?.classList.contains('stalled')).toBe(true);

    rowButton(el, 'my-repo', 'Refresh (re-analyze)').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    expect((el as unknown as { stalledIds: Set<string> }).stalledIds.has('my-repo')).toBe(false);
  });
});
