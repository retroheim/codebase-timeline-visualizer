import { LitElement, html, css, PropertyValues } from 'lit';
import * as d3 from 'd3';
import { activityAsOf, fileFactsAsOf } from '../lib/activity';
import { contributorColorScale } from '../lib/contributor-color';
import { isBotAuthor } from '../lib/bot-authors';
import { resolveFilePath } from '../lib/file-tree';
import { placeholderAvatarUrl, resolveGithubAvatar } from '../lib/github-avatar';
import { arcInterpolator, reservoirSample, revealCount } from '../lib/geometry';
import { computeTreeLayout, PointLink, PointNode, TreeLayout } from '../lib/tree-layout';
import './bot-group-toggle';
import type { CommitEvent, TimelineData } from '../types';

type ZoomTransform = { x: number; y: number; k: number };

const AUTOMATED = 'Automated';
const BOT_COLOR = 'var(--bloom, #c792ff)';

const MAX_SPARKS_PER_TICK = 8;
// Per-commit cap on individual spark lines, mirroring MAX_SPARKS_PER_TICK's
// per-tick cap — a commit touching hundreds of files (a mass rename, a
// generated-file regen) shouldn't fire hundreds of simultaneous sparks.
const MAX_TARGETS_PER_COMMIT = 5;
// A cluster can aggregate thousands of files; rendering that many <li> nodes
// in the inspector would be its own performance problem and nobody's
// scrolling through 4,000 filenames anyway.
const MAX_CLUSTER_MEMBERS_SHOWN = 200;
const EASES = [d3.easeCubicOut, d3.easeCubicOut, d3.easeBackOut.overshoot(1.4), d3.easeSinOut];
// Deletions dissolve rather than cut instantly, mirroring the "just arrived"
// glow on introduction — but bucketed into a handful of discrete stages
// rather than one continuous alpha per node. Canvas draw-call state
// (fillStyle/globalAlpha) can't vary within a single batched path, so a mass
// deletion (thousands of files removed in one commit, e.g. `rm -rf vendor/`)
// would otherwise cost one individual beginPath()/fill() call per dissolving
// node, every frame, for the whole fade window. A few stages keeps it to a
// few batched draw calls regardless of how many nodes are fading at once.
const REMOVAL_STAGES = [
  { alpha: 0.8, radiusScale: 0.8 },
  { alpha: 0.55, radiusScale: 0.55 },
  { alpha: 0.3, radiusScale: 0.32 },
  { alpha: 0.1, radiusScale: 0.12 },
];
// A window drag fires ResizeObserver every frame, and a rebuild is a full tree
// build plus layout plus SVG teardown. Coalesce to one per gesture.
const RESIZE_DEBOUNCE_MS = 120;

interface ContributorAvatar {
  el: d3.Selection<SVGGElement, unknown, null, undefined>;
  image: d3.Selection<SVGImageElement, unknown, null, undefined>;
  home: [number, number];
  current: [number, number];
}

export class TimelineViz extends LitElement {
  static properties = {
    data: { attribute: false },
    currentTime: { type: Number },
    selectedNode: { state: true },
    selectedClusterMember: { state: true },
    groupBots: { state: true },
  };

  declare data: TimelineData | null;
  declare currentTime: number;
  declare selectedNode: PointNode | null;
  /** Drill-down within the inspector: a specific file path inside the
   *  currently-selected cluster, shown with its own time-scoped stats. */
  declare selectedClusterMember: string | null;
  /** Whether bot/AI-model contributors (see lib/bot-authors.ts) share one
   *  "Automated" avatar/spark-color/inspector-listing instead of each
   *  getting their own. Defaults to grouped, matching the other views. */
  declare groupBots: boolean;

  private width = 800;
  private height = 600;
  private dpr = Math.max(1, window.devicePixelRatio || 1);
  private layout: TreeLayout | null = null;
  private colorScale: (author: string) => string = () => '#888';
  private contributors: Record<string, ContributorAvatar> = {};
  private prevTime = -1;
  private resizeObserver?: ResizeObserver;
  private resizeTimer = 0;

  // Directories double-clicked open — their file children render individually
  // instead of collapsing into a "N files" cluster, regardless of count.
  // Survives rebuilds (resize, playback) since it's keyed by path, not by
  // node identity.
  private expandedClusters = new Set<string>();

  // Nodes/links are revealed by advancing a cursor rather than re-scanning
  // everything already rendered. The canvas redraw is still O(revealed), but a
  // full repaint of even tens of thousands of circles is cheap — unlike keeping
  // that many live SVG elements in the DOM.
  private revealPointer = 0;
  private linkRevealPointer = 0;
  // Same cursor pattern, mirrored for removals: how many nodes have crossed
  // their removedAt as of currentTime. Walked backward from here, bounded by
  // glowWindow, to find the (small) set currently mid-dissolve.
  private removalPointer = 0;

  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private zoomTransform: ZoomTransform = { x: 0, y: 0, k: 1 };

  // Coalesces every draw trigger (zoom/pan events fire far faster than the
  // display refresh rate; currentTime can now change every animation frame
  // during playback) into at most one drawCanvas() per frame. Without this,
  // a trackpad pinch alone could call drawCanvas() dozens of times in a
  // single frame's worth of wall-clock time.
  private drawScheduled = false;
  private drawHandle?: number;

  // Bumped on every scene rebuild. Avatar lookups are async and capture their
  // target selection in a closure, so a lookup started before a rebuild would
  // otherwise resolve and write an href onto a node that has since been
  // discarded. Comparing generations makes those writes no-ops.
  private sceneGeneration = 0;
  // Resolved avatar URLs survive rebuilds, so a resize doesn't visibly drop
  // every contributor back to a placeholder while the lookups re-run.
  private avatarUrlByAuthor = new Map<string, string>();

  private svg?: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private zoomLayer?: d3.Selection<SVGGElement, unknown, null, undefined>;
  private sparkLayer?: d3.Selection<SVGGElement, unknown, null, undefined>;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }
    .timeline-wrapper {
      width: 100%;
      height: 100%;
      position: relative;
      background:
        radial-gradient(circle at 50% 42%, rgba(47, 230, 184, 0.05) 0%, transparent 55%),
        radial-gradient(1px 1px at 12% 18%, #fff, transparent),
        radial-gradient(1px 1px at 74% 8%, #fff, transparent),
        radial-gradient(1px 1px at 34% 64%, #fff, transparent),
        radial-gradient(1px 1px at 91% 38%, #fff, transparent),
        radial-gradient(1px 1px at 58% 82%, #fff, transparent),
        radial-gradient(1px 1px at 6% 76%, #fff, transparent),
        radial-gradient(1px 1px at 82% 68%, #fff, transparent),
        radial-gradient(1px 1px at 22% 92%, #fff, transparent),
        radial-gradient(1px 1px at 46% 30%, #fff, transparent),
        radial-gradient(1px 1px at 66% 52%, #fff, transparent),
        radial-gradient(circle at 30% 30%, #0d1424 0%, #060810 62%, #030408 100%);
      background-repeat: repeat, repeat, repeat, repeat, repeat, repeat, repeat, repeat, repeat, repeat, repeat, no-repeat;
      background-size: 100% 100%, 340px 340px, 280px 280px, 400px 400px, 300px 300px, 260px 260px, 380px 380px, 320px 320px, 360px 360px,
        420px 420px, 290px 290px, 100% 100%;
      overflow: hidden;
      animation: twinkle 7s ease-in-out infinite alternate;
    }
    @keyframes twinkle {
      from {
        background-position: 0 0, 0 0, 0 0, 0 0, 0 0, 0 0, 0 0, 0 0, 0 0, 0 0, 0 0, 0 0;
      }
      to {
        background-position: 0 0, 6px 4px, -4px 5px, 3px -6px, -5px 3px, 4px 6px, -3px -4px, 5px -3px, -6px -5px, 4px 3px, -4px -3px, 0 0;
      }
    }
    canvas,
    svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    svg {
      pointer-events: none;
    }
    .avatar-pulse {
      transform-box: fill-box;
      transform-origin: center;
      animation: avatar-breathe 3.2s ease-in-out infinite;
    }
    @keyframes avatar-breathe {
      0%,
      100% {
        transform: scale(1);
      }
      50% {
        transform: scale(1.08);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .timeline-wrapper {
        animation: none;
      }
      .avatar-pulse {
        animation: none;
      }
    }

    .controls {
      position: absolute;
      top: 78px;
      left: 20px;
      z-index: 4;
      pointer-events: auto;
    }

    .inspector {
      position: absolute;
      top: 20px;
      right: 20px;
      z-index: 4;
      width: 240px;
      max-width: calc(100% - 40px);
      padding: 14px 16px 16px;
      border-radius: 14px;
      background: rgba(13, 20, 36, 0.78);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05);
      font-family: var(--font-body, sans-serif);
      color: var(--paper, #e7edf5);
      pointer-events: auto;
    }
    .inspector-close {
      position: absolute;
      top: 8px;
      right: 10px;
      background: none;
      border: none;
      color: var(--mist, #55617a);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 4px;
    }
    .inspector-close:hover {
      color: var(--paper, #e7edf5);
    }
    .inspector-kind {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--thread, #2fe6b8);
      margin-bottom: 4px;
    }
    .inspector-name {
      font-weight: 600;
      font-size: 13.5px;
      word-break: break-word;
      margin-bottom: 10px;
      padding-right: 16px;
    }
    .inspector-facts {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px 10px;
      margin: 0;
    }
    .inspector-facts dt {
      font-size: 11px;
      color: var(--mist, #55617a);
    }
    .inspector-facts dd {
      margin: 0;
      font-family: var(--font-mono, monospace);
      font-size: 11.5px;
      text-align: right;
    }
    .inspector-extra {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 11px;
      color: var(--mist, #55617a);
      word-break: break-word;
    }
    .inspector-hint {
      margin-top: 10px;
      font-size: 10.5px;
      color: var(--mist, #55617a);
      font-style: italic;
    }
    .cluster-members {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .cluster-members-label {
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--mist, #55617a);
      margin-bottom: 6px;
    }
    .cluster-members ul {
      list-style: none;
      margin: 0;
      padding: 0;
      max-height: 160px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .cluster-member-btn {
      display: block;
      width: 100%;
      text-align: left;
      background: none;
      border: none;
      border-radius: 5px;
      padding: 4px 6px;
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      color: var(--paper, #e7edf5);
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cluster-member-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--thread, #2fe6b8);
    }
    .cluster-members-more {
      margin-top: 4px;
      font-size: 10.5px;
      color: var(--mist, #55617a);
    }
    .cluster-back {
      background: none;
      border: none;
      color: var(--thread, #2fe6b8);
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      cursor: pointer;
      padding: 0 0 10px;
      margin: 0;
    }
    .cluster-back:hover {
      text-decoration: underline;
    }
  `;

  constructor() {
    super();
    this.data = null;
    this.currentTime = 0;
    this.selectedNode = null;
    this.selectedClusterMember = null;
    this.groupBots = true;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Observe here, not in firstUpdated(): firstUpdated fires once per element
    // lifetime, so after a disconnect/reconnect (any DOM reparent) the fresh
    // observer created here would never be attached and resize would silently
    // stop working for the rest of the session.
    this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    window.clearTimeout(this.resizeTimer);
    if (this.drawHandle !== undefined) window.cancelAnimationFrame(this.drawHandle);
    this.drawScheduled = false;
    // Any avatar lookup still in flight resolves against a scene that no
    // longer exists.
    this.sceneGeneration += 1;
  }

  /** Coalesce draw requests to one `drawCanvas()` per animation frame. */
  private scheduleDraw(): void {
    if (this.drawScheduled) return;
    this.drawScheduled = true;
    this.drawHandle = window.requestAnimationFrame(() => {
      this.drawScheduled = false;
      this.drawCanvas();
    });
  }

  firstUpdated(): void {
    this.handleResize();
  }

  private scheduleResize(): void {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.handleResize(), RESIZE_DEBOUNCE_MS);
  }

  private handleResize(): void {
    const rect = this.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.width === this.width && rect.height === this.height && this.layout) return;
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.rebuildScene({ replaySparks: false });
  }

  updated(changed: PropertyValues): void {
    if (changed.has('data')) {
      this.rebuildScene({ replaySparks: false });
    }
    if (changed.has('currentTime') && !changed.has('data')) {
      this.applyTimeStep();
    }
    if (changed.has('selectedNode') && !changed.has('data') && !changed.has('currentTime')) {
      this.scheduleDraw();
    }
  }

  render() {
    return html`
      <div class="timeline-wrapper">
        <canvas></canvas>
        <svg></svg>
        <div class="controls">
          <bot-group-toggle .grouped=${this.groupBots} @bot-group-change=${this.handleBotGroupChange}></bot-group-toggle>
        </div>
        ${this.selectedNode ? this.renderInspector(this.selectedNode) : null}
      </div>
    `;
  }

  private handleBotGroupChange = (event: CustomEvent<{ grouped: boolean }>): void => {
    this.groupBots = event.detail.grouped;
    // Which avatars exist (one "Automated" vs. one per bot) changes, so the
    // avatar layer has to be rebuilt, not just recolored.
    this.rebuildScene({ replaySparks: false });
  };

  /** Where a bot author's identity is folded into the shared "Automated"
   *  pseudo-contributor — avatar lookup, spark origin, inspector listings —
   *  so all three stay in agreement about what's grouped right now. */
  private displayAuthor(author: string): string {
    return this.groupBots && isBotAuthor(author) ? AUTOMATED : author;
  }

  private colorForAuthor(author: string): string {
    return this.groupBots && isBotAuthor(author) ? BOT_COLOR : this.colorScale(author);
  }

  /** Same grouping applied to a set of real author names pulled from
   *  activity/file facts, for the inspector's "Contributors" count/list. */
  private displayAuthors(authors: Set<string>): Set<string> {
    if (!this.groupBots) return authors;
    return new Set([...authors].map((a) => this.displayAuthor(a)));
  }

  private closeInspector = (): void => {
    this.selectedNode = null;
    this.selectedClusterMember = null;
  };

  private renderInspector(node: PointNode) {
    if (node.data.isCluster && this.selectedClusterMember) {
      return html`
        <div class="inspector">
          <button class="inspector-close" @click=${this.closeInspector} aria-label="Close">×</button>
          ${this.renderClusterMemberDetail(this.selectedClusterMember)}
        </div>
      `;
    }

    const info = this.describeNode(node);
    return html`
      <div class="inspector">
        <button class="inspector-close" @click=${this.closeInspector} aria-label="Close">×</button>
        <div class="inspector-kind">${info.kind}</div>
        <div class="inspector-name" title=${info.path}>${info.name}</div>
        <dl class="inspector-facts">
          ${info.facts.map((f) => html`<dt>${f.label}</dt>
            <dd>${f.value}</dd>`)}
        </dl>
        ${node.data.isCluster
          ? this.renderClusterMemberList(info.members ?? [])
          : info.extra
          ? html`<div class="inspector-extra">${info.extra}</div>`
          : null}
        ${node.data.isCluster && node.data.clusterOwnerPath !== undefined
          ? html`<div class="inspector-hint">Double-click the group to open its full tree</div>`
          : null}
      </div>
    `;
  }

  private renderClusterMemberList(members: string[]) {
    if (members.length === 0) return null;
    const shown = members.slice(0, MAX_CLUSTER_MEMBERS_SHOWN);
    const hiddenCount = members.length - shown.length;
    return html`
      <div class="cluster-members">
        <div class="cluster-members-label">Files in this group</div>
        <ul>
          ${shown.map(
            (path) => html`
              <li>
                <button class="cluster-member-btn" @click=${() => (this.selectedClusterMember = path)}>
                  ${path.split('/').pop()}
                </button>
              </li>
            `
          )}
        </ul>
        ${hiddenCount > 0 ? html`<div class="cluster-members-more">+${hiddenCount} more not shown</div>` : null}
      </div>
    `;
  }

  private renderClusterMemberDetail(path: string) {
    const timeline = this.data?.timeline ?? [];
    const facts = fileFactsAsOf(timeline, path, this.currentTime);
    const back = html`<button class="cluster-back" @click=${() => (this.selectedClusterMember = null)}>
      ‹ Back to group
    </button>`;

    if (!facts) {
      return html`
        ${back}
        <div class="inspector-name" title=${path}>${path.split('/').pop()}</div>
        <div class="inspector-extra">Not part of the repo yet at this point in time.</div>
      `;
    }

    const introducedEvent = timeline[facts.introducedAt];
    const firstSeen = introducedEvent ? new Date(introducedEvent.timestamp * 1000).toLocaleDateString() : '—';
    const removedFact =
      facts.removedAt !== undefined && !facts.alive
        ? [{ label: 'Removed', value: new Date((timeline[facts.removedAt]?.timestamp ?? 0) * 1000).toLocaleDateString() }]
        : [];
    const authors = this.displayAuthors(facts.activity.authors);
    const memberFacts = [
      { label: 'Edits', value: String(facts.activity.edits) },
      { label: 'First appeared', value: firstSeen },
      ...removedFact,
      { label: 'Lines added', value: `+${facts.activity.linesAdded}` },
      { label: 'Lines removed', value: `-${facts.activity.linesRemoved}` },
      { label: 'Contributors', value: String(authors.size) },
    ];

    return html`
      ${back}
      <div class="inspector-kind">File</div>
      <div class="inspector-name" title=${path}>${path.split('/').pop()}</div>
      <dl class="inspector-facts">
        ${memberFacts.map((f) => html`<dt>${f.label}</dt>
          <dd>${f.value}</dd>`)}
      </dl>
      ${authors.size > 0 ? html`<div class="inspector-extra">${[...authors].join(', ')}</div>` : null}
    `;
  }

  private describeNode(node: PointNode): {
    kind: string;
    name: string;
    path: string;
    facts: { label: string; value: string }[];
    extra?: string;
    members?: string[];
  } {
    const d = node.data;
    const currentTime = this.currentTime;
    const timeline = this.data?.timeline ?? [];
    const introducedEvent = timeline[d.introducedAt];
    const firstSeen = introducedEvent ? new Date(introducedEvent.timestamp * 1000).toLocaleDateString() : '—';
    // Only worth surfacing once currentTime has actually passed the removal
    // point — the node is still alive up to and including that commit.
    const removedFact =
      d.removedAt !== undefined && this.isRemoved(node, currentTime)
        ? [{ label: 'Removed', value: new Date((timeline[d.removedAt]?.timestamp ?? 0) * 1000).toLocaleDateString() }]
        : [];

    if (d.isCluster) {
      const memberPaths = this.layout?.clusterMembers.get(d.path) ?? [];
      const memberSet = new Set(memberPaths);
      // "Files in group" reflects who's still actually there right now, not
      // everyone who was ever swept into this cluster over the repo's life.
      // A cluster member's individual TreeNode is dropped once folded into
      // the aggregate (collapseClusters() never keeps it), so it can't be
      // looked up via layout.nodeByPath the way a normal node can —
      // fileFactsAsOf reads its introducedAt/alive state straight from the
      // raw timeline instead.
      const liveMembers = memberPaths.filter((p) => fileFactsAsOf(timeline, p, currentTime)?.alive ?? false);
      const activity = activityAsOf(timeline, (p) => memberSet.has(p), currentTime);
      return {
        kind: 'Grouped files',
        name: d.name,
        path: d.path,
        facts: [
          { label: 'Files in group', value: String(liveMembers.length) },
          { label: 'Combined edits', value: String(activity.edits) },
          { label: 'First appeared', value: firstSeen },
          ...removedFact,
        ],
        members: liveMembers,
      };
    }

    if (d.isFile) {
      const activity = activityAsOf(timeline, (p) => p === d.path, currentTime);
      const authors = this.displayAuthors(activity.authors);
      const facts = [
        { label: 'Edits', value: String(activity.edits) },
        { label: 'First appeared', value: firstSeen },
        ...removedFact,
        { label: 'Lines added', value: `+${activity.linesAdded}` },
        { label: 'Lines removed', value: `-${activity.linesRemoved}` },
        { label: 'Contributors', value: String(authors.size) },
      ];
      return {
        kind: 'File',
        name: d.name,
        path: d.path,
        facts,
        extra: authors.size > 0 ? [...authors].join(', ') : undefined,
      };
    }

    const isRoot = !node.parent;
    const prefix = `${d.path}/`;
    const matchesSubtree = (p: string) => isRoot || p === d.path || p.startsWith(prefix);
    const activity = activityAsOf(timeline, matchesSubtree, currentTime);
    const liveFileCount = node
      .leaves()
      .filter((leaf) => leaf.data.introducedAt <= currentTime && !this.isRemoved(leaf, currentTime)).length;

    return {
      kind: node.parent ? 'Directory' : 'Repository root',
      name: d.name || '/',
      path: d.path || '/',
      facts: [
        { label: 'Files inside', value: String(liveFileCount) },
        { label: 'Total edits', value: String(activity.edits) },
        { label: 'First appeared', value: firstSeen },
        ...removedFact,
      ],
    };
  }

  /** Files below the zoom threshold aren't drawn, so they mustn't be clickable
   *  either — one predicate, used by both paths, or the two drift apart. */
  private isHidden(n: PointNode, zoomK = this.zoomTransform.k): boolean {
    const showFiles = zoomK >= (this.layout?.sizing.fileZoomThreshold ?? 0);
    return n.data.isFile && !n.data.isCluster && !showFiles;
  }

  /**
   * A file (or a directory/cluster with nothing live left under it) that has
   * been deleted as of `currentTime` shouldn't still be sitting in the
   * animation as a ghost. `> removedAt` rather than `>=` so the commit that
   * does the deleting still shows the node one last time — including as a
   * spark target — before it vanishes on the next tick.
   */
  private isRemoved(n: PointNode, currentTime = this.currentTime): boolean {
    const removedAt = n.data.removedAt;
    return removedAt !== undefined && currentTime > removedAt;
  }

  private radiusFor(n: PointNode): number {
    return n.data.layoutRadius ?? 2;
  }

  /**
   * Recompute the layout and rebuild the SVG scene. `replaySparks` is false for
   * a resize: the old code reset prevTime to -1 and stepped from scratch, which
   * re-sampled a spark burst over the entire history every time the window
   * moved.
   */
  private rebuildScene({ replaySparks }: { replaySparks: boolean }): void {
    const timeline = this.data?.timeline ?? [];
    const canvasEl = this.renderRoot.querySelector('canvas');
    const svgEl = this.renderRoot.querySelector('svg');
    if (!canvasEl || !svgEl || timeline.length === 0) return;

    // Node objects get rebuilt below, so re-resolve the selection by path
    // afterwards (survives a resize; a genuinely different repo just won't
    // have that path and selection clears, which is correct).
    const prevSelectedPath = this.selectedNode?.data.path;

    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d') ?? undefined;
    canvasEl.width = this.width * this.dpr;
    canvasEl.height = this.height * this.dpr;

    this.layout = computeTreeLayout(timeline, this.width, this.height, this.expandedClusters);
    if (!this.layout) return;

    this.selectedNode = prevSelectedPath ? this.layout.nodeByPath.get(prevSelectedPath) ?? null : null;

    this.colorScale = this.data ? contributorColorScale(this.data) : () => '#888';

    this.buildSvgScene(svgEl, timeline);

    if (replaySparks) {
      this.prevTime = -1;
      this.applyTimeStep();
    } else {
      // Jump straight to the current instant: same revealed set as playing
      // forward to it, without re-firing every spark along the way.
      this.syncToCurrentTime();
    }
  }

  private buildSvgScene(svgEl: SVGSVGElement, timeline: CommitEvent[]): void {
    const generation = (this.sceneGeneration += 1);

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${this.width} ${this.height}`);

    // The zoom layer below is brand new and therefore untransformed, so the
    // retained transform would leave the canvas and the SVG in different
    // coordinate systems — avatars floating away from the tree they belong to.
    this.zoomTransform = { x: 0, y: 0, k: 1 };

    const defs = svg.append('defs');
    const zoomLayer = svg.append('g').attr('class', 'zoom-layer');
    this.zoomLayer = zoomLayer;
    this.svg = svg;

    const cx = this.width / 2;
    const cy = this.height / 2;

    const canvasEl = this.canvas!;
    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.15, 8])
      .on('zoom', (event) => {
        this.zoomTransform = event.transform;
        zoomLayer.attr('transform', event.transform);
        this.scheduleDraw();
      });
    d3.select(canvasEl).call(zoom);
    // d3 keeps the transform on the node itself; without this the next gesture
    // resumes from the pre-rebuild transform we just discarded.
    d3.select(canvasEl).call(zoom.transform, d3.zoomIdentity);
    // d3.zoom() binds its own double-click-to-zoom-in under the `.zoom`
    // namespace by default; drop only that listener (leaving wheel/drag zoom
    // intact) so double-click means "expand this cluster" unambiguously.
    d3.select(canvasEl).on('dblclick.zoom', null);
    d3.select(canvasEl).on('click', (event: MouseEvent) => this.handleCanvasClick(event));
    d3.select(canvasEl).on('dblclick.expand', (event: MouseEvent) => this.handleCanvasDblClick(event));

    this.sparkLayer = zoomLayer.append('g').attr('class', 'sparks').attr('transform', `translate(${cx},${cy})`);

    const realAuthors = Object.keys(this.data?.contributors ?? {});
    const hasBots = realAuthors.some(isBotAuthor);
    const authorNames =
      this.groupBots && hasBots ? [...realAuthors.filter((a) => !isBotAuthor(a)), AUTOMATED] : realAuthors;
    const homeRadius = 36;
    const avatarLayer = zoomLayer
      .append('g')
      .attr('class', 'contributors')
      .attr('transform', `translate(${cx},${cy})`);

    const githubRepo = this.data?.metadata.github_repo ?? null;
    const authorLatestSha = new Map<string, string>();
    timeline.forEach((commit) => authorLatestSha.set(commit.author, commit.commit_hash));

    this.contributors = {};
    authorNames.forEach((author, i) => {
      const angle = (i / Math.max(authorNames.length, 1)) * 2 * Math.PI;
      const hx = homeRadius * Math.cos(angle);
      const hy = homeRadius * Math.sin(angle);

      // "Automated" isn't a real key in data.contributors, so it has no
      // earned place in the per-author ordinal scale — fixed violet instead,
      // matching the leaderboard/commit-log treatment.
      const color = author === AUTOMATED ? BOT_COLOR : this.colorScale(author);
      const gradId = `avatar-glow-${i}`;
      const clipId = `avatar-clip-${i}`;
      defs
        .append('radialGradient')
        .attr('id', gradId)
        .attr('cx', '35%')
        .attr('cy', '30%')
        .call((g) => {
          g.append('stop').attr('offset', '0%').attr('stop-color', '#ffffff').attr('stop-opacity', 0.95);
          g.append('stop').attr('offset', '35%').attr('stop-color', color);
          g.append('stop').attr('offset', '100%').attr('stop-color', color).attr('stop-opacity', 0.85);
        });
      defs.append('clipPath').attr('id', clipId).append('circle').attr('r', 7);

      const wrap = avatarLayer
        .append('g')
        .attr('class', 'contributor')
        .attr('transform', `translate(${hx},${hy})`)
        .attr('style', `filter: drop-shadow(0 0 6px ${color}) drop-shadow(0 0 14px ${color}40)`);

      const pulse = wrap.append('g').attr('class', 'avatar-pulse');

      // A tilted ring, like a little Saturn — reads as "a person orbiting
      // their part of the codebase" rather than a plain flat dot.
      pulse
        .append('ellipse')
        .attr('rx', 12.5)
        .attr('ry', 4)
        .attr('transform', 'rotate(-24)')
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-opacity', 0.55)
        .attr('stroke-width', 1);

      // Gradient disc paints instantly; the image starts as a placeholder and
      // gets upgraded in place to the contributor's real GitHub avatar once
      // resolved — from the noreply-email pattern instantly, or from GitHub's
      // commit API (the same "who authored this" resolution GitHub uses on PRs
      // and commit pages) for real emails.
      pulse.append('circle').attr('r', 7).attr('fill', `url(#${gradId})`);

      const email = this.data?.contributors?.[author]?.email ?? author;
      const image = pulse
        .append('image')
        .attr('x', -7)
        .attr('y', -7)
        .attr('width', 14)
        .attr('height', 14)
        .attr('clip-path', `url(#${clipId})`)
        // Seed from the cache so a rebuild doesn't visibly drop everyone back
        // to a placeholder while the same lookups run again.
        .attr('href', this.avatarUrlByAuthor.get(author) ?? placeholderAvatarUrl(email))
        .attr('preserveAspectRatio', 'xMidYMid slice');

      const sha = authorLatestSha.get(author);
      if (sha && !this.avatarUrlByAuthor.has(author)) {
        resolveGithubAvatar(githubRepo, email, sha, author).then((url) => {
          if (!url) return;
          this.avatarUrlByAuthor.set(author, url);
          // The scene may have been rebuilt while this was in flight; writing
          // to the detached selection would be a silent no-op that also leaves
          // the live scene showing a placeholder.
          if (generation !== this.sceneGeneration) return;
          image.attr('href', url);
        });
      }

      pulse
        .append('circle')
        .attr('r', 7)
        .attr('fill', 'none')
        .attr('stroke', '#060810')
        .attr('stroke-width', 1.25);

      this.contributors[author] = { el: wrap, image, home: [hx, hy], current: [hx, hy] };
    });
  }

  /** Reveal exactly what `currentTime` implies, with no animation. */
  private syncToCurrentTime(): void {
    if (!this.layout) return;
    this.revealPointer = revealCount(this.layout.nodeIntroductions, this.currentTime);
    this.linkRevealPointer = revealCount(this.layout.linkIntroductions, this.currentTime);
    this.removalPointer = revealCount(this.layout.removalTimes, this.currentTime);
    this.snapContributorsHome();
    this.prevTime = this.currentTime;
    this.scheduleDraw();
  }

  private snapContributorsHome(): void {
    this.sparkLayer?.selectAll('path').interrupt().remove();
    Object.values(this.contributors).forEach((c) => {
      c.el.interrupt().attr('transform', `translate(${c.home[0]},${c.home[1]})`);
      c.current = c.home;
    });
  }

  private applyTimeStep(): void {
    const data = this.data;
    if (!this.layout || !data || !this.ctx) return;

    const currentTime = this.currentTime;
    const prevTime = this.prevTime;

    if (currentTime < prevTime) {
      this.rewindTo(currentTime);
    } else {
      this.advancePointers(currentTime);
      this.shootContributors(data.timeline, prevTime, currentTime);
    }

    this.scheduleDraw();
    this.prevTime = currentTime;
  }

  private rewindTo(currentTime: number): void {
    if (!this.layout) return;
    this.revealPointer = revealCount(this.layout.nodeIntroductions, currentTime);
    this.linkRevealPointer = revealCount(this.layout.linkIntroductions, currentTime);
    this.removalPointer = revealCount(this.layout.removalTimes, currentTime);
    // Sparks in flight are animating toward targets from the timeline we just
    // rewound past; without this they keep drawing against stale positions
    // after the contributors themselves have been snapped home.
    this.snapContributorsHome();
  }

  private advancePointers(currentTime: number): void {
    const layout = this.layout;
    if (!layout) return;
    while (
      this.linkRevealPointer < layout.linkIntroductions.length &&
      layout.linkIntroductions[this.linkRevealPointer] <= currentTime
    ) {
      this.linkRevealPointer += 1;
    }
    while (
      this.revealPointer < layout.nodeIntroductions.length &&
      layout.nodeIntroductions[this.revealPointer] <= currentTime
    ) {
      this.revealPointer += 1;
    }
    while (
      this.removalPointer < layout.removalTimes.length &&
      layout.removalTimes[this.removalPointer] <= currentTime
    ) {
      this.removalPointer += 1;
    }
  }

  private drawCanvas(): void {
    const ctx = this.ctx;
    const layout = this.layout;
    if (!ctx || !this.canvas || !layout) return;

    const { dpr, width, height, zoomTransform: t } = this;
    const { sizing, nodesByIntroduction, linksByIntroduction } = layout;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);
    ctx.translate(width / 2, height / 2);

    // Iterate to the reveal pointer rather than slicing: `slice` allocated a
    // fresh array on every pass, several times per frame, on every zoom event.
    const linkCount = this.linkRevealPointer;
    const nodeCount = this.revealPointer;

    // Links, directories, and files are drawn in per-(branch, depth) color
    // buckets rather than one shared teal/blue — which top-level directory a
    // node lives under, and how many levels deep it sits within that branch,
    // reads straight off its color. Canvas draw-call state (fillStyle/
    // strokeStyle/lineWidth) can't vary within a single batched path, so
    // same-colored nodes are grouped by their precomputed branchBucket
    // (unique per branch+depth, so every node in a bucket shares one exact
    // color — see tree-layout.ts) and each non-empty bucket gets one draw
    // call: the same trade REMOVAL_STAGES makes for fade progress, just
    // keyed by branch color instead. A Map rather than a pre-sized array
    // since a branch's actual depth (and so how many distinct buckets it
    // needs) isn't known/bounded in advance.
    const linkBuckets = new Map<number, PointLink[]>();
    for (let i = 0; i < linkCount; i += 1) {
      const link = linksByIntroduction[i];
      if (this.isHidden(link.target) || this.isRemoved(link.target)) continue;
      const bucket = link.target.data.branchBucket;
      if (bucket === undefined) continue;
      const list = linkBuckets.get(bucket);
      if (list) list.push(link);
      else linkBuckets.set(bucket, [link]);
    }
    for (const links of linkBuckets.values()) {
      const target = links[0].target.data;
      const [r, g, bl] = target.colorRgb!;
      // Thinner and a touch more transparent deeper into a branch, so
      // trunk-adjacent connections read as structurally more prominent than
      // twig-tip ones — the link mirrors the same "further down the line"
      // progression the node colors do. Clamped so a very deep link never
      // vanishes to zero width/alpha.
      const depthT = Math.min(1, target.branchDepth! / 12);
      ctx.strokeStyle = `rgba(${r}, ${g}, ${bl}, ${sizing.linkAlpha * (1.3 - depthT * 0.7)})`;
      ctx.lineWidth = (sizing.stroke * Math.max(0.5, 1.5 - depthT * 0.9)) / t.k;
      ctx.shadowColor = `rgba(${r}, ${g}, ${bl}, 0.5)`;
      ctx.shadowBlur = sizing.stroke * 2;
      ctx.beginPath();
      for (const link of links) {
        // Precomputed at layout time: no per-frame trig, no per-frame array
        // allocation. This loop is the single hottest path in the renderer
        // during playback and zoom, so this is where it matters most.
        const arc = link.target.data.arcPoints!;
        ctx.moveTo(arc[0], arc[1]);
        for (let j = 2; j < arc.length; j += 2) ctx.lineTo(arc[j], arc[j + 1]);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    const currentTime = this.currentTime;

    const dirBuckets = new Map<number, PointNode[]>();
    const fileBuckets = new Map<number, PointNode[]>();
    for (let i = 0; i < nodeCount; i += 1) {
      const n = nodesByIntroduction[i];
      if (this.isRemoved(n)) continue;
      const bucket = n.data.branchBucket;
      if (bucket === undefined) continue;
      const buckets = n.data.isFile ? fileBuckets : dirBuckets;
      if (n.data.isFile && this.isHidden(n)) continue;
      const list = buckets.get(bucket);
      if (list) list.push(n);
      else buckets.set(bucket, [n]);
    }
    const fillBucket = (nodes: PointNode[], alpha: number, shadowAlpha: number, shadowBlur: number) => {
      const [r, g, b] = nodes[0].data.colorRgb!;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${shadowAlpha})`;
      ctx.shadowBlur = shadowBlur;
      ctx.beginPath();
      for (const n of nodes) {
        const x = n.data.layoutX!;
        const y = n.data.layoutY!;
        const r2 = n.data.layoutRadius!;
        ctx.moveTo(x + r2, y);
        ctx.arc(x, y, r2, 0, 2 * Math.PI);
      }
      ctx.fill();
    };
    for (const nodes of dirBuckets.values()) fillBucket(nodes, sizing.dirAlpha, 0.85, 3.5);
    for (const nodes of fileBuckets.values()) fillBucket(nodes, sizing.fileAlpha, 0.85, 2.5);
    ctx.shadowBlur = 0;

    // Cluster nodes get a ring so "this is a group" reads visually distinct
    // from "this is one very active file".
    ctx.strokeStyle = 'rgba(255, 200, 160, 0.55)';
    ctx.lineWidth = 0.75 / t.k;
    ctx.beginPath();
    for (let i = 0; i < nodeCount; i += 1) {
      const n = nodesByIntroduction[i];
      if (!n.data.isCluster || this.isRemoved(n)) continue;
      const x = n.data.layoutX!;
      const y = n.data.layoutY!;
      const r = n.data.layoutRadius! + 1.5;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, 2 * Math.PI);
    }
    ctx.stroke();

    // The root gets its own small hub marker — everything else radiates
    // from here, worth marking distinctly rather than blending into the
    // directory layer.
    ctx.fillStyle = '#eafff8';
    ctx.shadowColor = 'rgba(47, 230, 184, 0.9)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(0, 0, 2.4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Brief glow on whatever was introduced most recently, so growth still
    // reads even though old nodes no longer individually animate in. Files
    // hidden below the zoom threshold glow at their parent directory instead
    // of not registering at all.
    ctx.fillStyle = '#fff2e6';
    ctx.shadowColor = '#ffb37a';
    ctx.shadowBlur = 6;
    for (let i = nodeCount - 1; i >= 0; i -= 1) {
      const n = nodesByIntroduction[i];
      const age = currentTime - n.data.introducedAt;
      if (age > layout.glowWindow) break;
      if (this.isRemoved(n)) continue;
      const target = this.isHidden(n) ? n.parent ?? n : n;
      const x = target.data.layoutX!;
      const y = target.data.layoutY!;
      const alpha = 1 - age / layout.glowWindow;
      const r = this.radiusFor(target) * (1 + alpha * 1.8);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    // Deletions dissolve rather than cut instantly, fading using each node's
    // own branch color rather than a flat teal/blue — a file fading away
    // should fade using the color it was actually drawn in the moment
    // before. Bucketed by fade stage AND (branch, isFile); the removal-
    // pointer walk itself is still bounded by glowWindow, so a mass deletion
    // is still a handful of batched draw calls, not one per node — the extra
    // color dimension only adds more (empty-skippable) buckets, not more
    // per-node work.
    const dissolveBuckets: Map<number, PointNode[]>[] = Array.from(
      { length: REMOVAL_STAGES.length },
      () => new Map()
    );
    for (let i = this.removalPointer - 1; i >= 0; i -= 1) {
      const n = layout.nodesByRemoval[i];
      const age = currentTime - n.data.removedAt!;
      if (age > layout.glowWindow) break;
      if (this.isHidden(n)) continue;
      const branchBucket = n.data.branchBucket;
      if (branchBucket === undefined) continue;
      const stage = Math.min(
        REMOVAL_STAGES.length - 1,
        Math.floor((age / layout.glowWindow) * REMOVAL_STAGES.length)
      );
      const key = branchBucket * 2 + (n.data.isFile ? 1 : 0);
      const byKey = dissolveBuckets[stage];
      const list = byKey.get(key);
      if (list) list.push(n);
      else byKey.set(key, [n]);
    }
    for (let s = 0; s < REMOVAL_STAGES.length; s += 1) {
      const { alpha, radiusScale } = REMOVAL_STAGES[s];
      for (const nodes of dissolveBuckets[s].values()) {
        const [r, g, b] = nodes[0].data.colorRgb!;
        const baseAlpha = nodes[0].data.isFile ? sizing.fileAlpha : sizing.dirAlpha;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${baseAlpha * alpha})`;
        ctx.beginPath();
        for (const n of nodes) {
          const x = n.data.layoutX!;
          const y = n.data.layoutY!;
          const r2 = n.data.layoutRadius! * radiusScale;
          ctx.moveTo(x + r2, y);
          ctx.arc(x, y, r2, 0, 2 * Math.PI);
        }
        ctx.fill();
      }
    }

    if (
      this.selectedNode &&
      this.selectedNode.data.introducedAt <= currentTime &&
      !this.isRemoved(this.selectedNode)
    ) {
      const x = this.selectedNode.data.layoutX!;
      const y = this.selectedNode.data.layoutY!;
      const base = this.radiusFor(this.selectedNode);
      ctx.strokeStyle = '#ff8a5c';
      ctx.lineWidth = 1.25 / t.k;
      ctx.shadowColor = 'rgba(255, 138, 92, 0.8)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(x, y, base + 4 / t.k, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  // Screen (client) coordinates -> the same local "tree space" coordinates
  // everything is drawn in, inverting the zoom/pan transform + centering
  // translate applied at the top of drawCanvas.
  private screenToLocal(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas!.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const t = this.zoomTransform;
    return [(sx - t.x) / t.k - this.width / 2, (sy - t.y) / t.k - this.height / 2];
  }

  /** Shared by click (select) and dblclick (expand a cluster) so the two
   *  paths can never disagree about what's under the cursor. */
  private hitTestNode(clientX: number, clientY: number): PointNode | null {
    const layout = this.layout;
    if (!layout) return null;
    const [lx, ly] = this.screenToLocal(clientX, clientY);

    let best: PointNode | null = null;
    let bestDist = Infinity;
    const clickPad = 6 / this.zoomTransform.k;

    for (let i = 0; i < this.revealPointer; i += 1) {
      const n = layout.nodesByIntroduction[i];
      if (this.isHidden(n) || this.isRemoved(n)) continue;
      const x = n.data.layoutX!;
      const y = n.data.layoutY!;
      const r = this.radiusFor(n) + clickPad;
      const dist = Math.hypot(x - lx, y - ly);
      if (dist <= r && dist < bestDist) {
        best = n;
        bestDist = dist;
      }
    }

    return best;
  }

  private handleCanvasClick(event: MouseEvent): void {
    this.selectedNode = this.hitTestNode(event.clientX, event.clientY);
    this.selectedClusterMember = null;
  }

  /** Double-clicking a cluster shows every file it aggregates individually,
   *  regardless of count, instead of the "N files" aggregate. */
  private handleCanvasDblClick(event: MouseEvent): void {
    const node = this.hitTestNode(event.clientX, event.clientY);
    // `clusterOwnerPath` is '' for a cluster of root-level files — an empty
    // but perfectly valid path, so this must check presence, not truthiness.
    if (!node?.data.isCluster || node.data.clusterOwnerPath === undefined) return;
    this.expandedClusters.add(node.data.clusterOwnerPath);
    this.selectedNode = null;
    this.selectedClusterMember = null;
    this.rebuildScene({ replaySparks: false });
  }

  private shootContributors(timeline: CommitEvent[], prevTime: number, currentTime: number): void {
    const layout = this.layout;
    if (!layout) return;
    const commitsInRange = timeline.slice(Math.max(prevTime + 1, 0), currentTime + 1);
    if (commitsInRange.length === 0) return;

    // Random subset (not evenly-spaced picks) so bursts feel less mechanical
    // when many commits land in a single tick. On a large repo playing back
    // fast, commitsInRange can be hundreds of commits long every tick — an
    // O(n log n) shuffle-via-sort just to keep 8 of them is wasted work (and
    // `.sort(() => Math.random() - 0.5)` is a well-known biased shuffle
    // besides). reservoirSample is O(n) with no intermediate array.
    const sampled =
      commitsInRange.length <= MAX_SPARKS_PER_TICK
        ? commitsInRange
        : reservoirSample(commitsInRange, MAX_SPARKS_PER_TICK).sort((a, b) => a.timestamp - b.timestamp);

    sampled.forEach((commit, i) => {
      const contributor = this.contributors[this.displayAuthor(commit.author)];
      if (!contributor) return;

      const allTargets = (commit.files_changed || [])
        .map((f) => {
          const path = resolveFilePath(f);
          const clusterPath = layout.fileClusterMap.get(path);
          // Without the guard an unclustered, unknown path looked up '' and
          // silently resolved to the root node, sending the spark to the hub.
          return layout.nodeByPath.get(path) ?? (clusterPath ? layout.nodeByPath.get(clusterPath) : undefined);
        })
        .filter((n): n is PointNode => Boolean(n));
      if (allTargets.length === 0) return;

      // A commit touching dozens of files would otherwise fire that many
      // individual spark draw calls every tick — cap it the same way
      // MAX_SPARKS_PER_TICK caps commits.
      const targets =
        allTargets.length <= MAX_TARGETS_PER_COMMIT
          ? allTargets
          : reservoirSample(allTargets, MAX_TARGETS_PER_COMMIT);

      const from = contributor.current;
      const delay = i * (280 / sampled.length) + Math.random() * 40;
      const duration = 200 + Math.random() * 160;
      const ease = EASES[Math.floor(Math.random() * EASES.length)];

      // One spark per touched node, landing exactly on that node's own
      // coordinates — not one spark at the (possibly jittered) midpoint
      // between every file the commit touched, which for a multi-file
      // commit lands in empty space rather than on anything.
      targets.forEach((targetNode) => {
        const to: [number, number] = [targetNode.data.layoutX!, targetNode.data.layoutY!];
        const interpolate = arcInterpolator(from, to);

        const path = this.sparkLayer!
          .append('path')
          .attr('fill', 'none')
          .attr('stroke', this.colorForAuthor(commit.author))
          .attr('stroke-width', 1.5)
          .attr('opacity', 0);

        path
          .transition()
          .delay(delay)
          .duration(duration)
          .ease(ease)
          .tween('spark', () => (t: number) => {
            const head = interpolate(t);
            path.attr('d', `M${from[0]},${from[1]} L${head[0]},${head[1]}`).attr('opacity', 0.85 * (1 - t * 0.3));
          })
          .transition()
          .duration(220)
          .attr('opacity', 0)
          .on('end', () => path.remove());
      });

      // The avatar itself settles on the last node it touched this commit —
      // a real, exact node position, not an averaged point that can land
      // between several files with nothing actually there.
      const to: [number, number] = [
        targets[targets.length - 1].data.layoutX!,
        targets[targets.length - 1].data.layoutY!,
      ];
      const avatarInterpolate = arcInterpolator(from, to);

      contributor.el
        .transition()
        .delay(delay)
        .duration(duration)
        .ease(ease)
        // Track `current` from inside the tween, not synchronously after
        // scheduling. A tick arriving before this transition finishes reads
        // `current` as its own `from`; if that were already set to the
        // not-yet-reached destination, the avatar would jump there instead of
        // continuing from where it actually is.
        .tween('move', () => (t: number) => {
          const point = avatarInterpolate(t);
          contributor.current = point;
          contributor.el.attr('transform', `translate(${point[0]},${point[1]})`);
        });
    });
  }
}

customElements.define('timeline-viz', TimelineViz);

declare global {
  interface HTMLElementTagNameMap {
    'timeline-viz': TimelineViz;
  }
}
