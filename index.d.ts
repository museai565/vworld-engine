/**
 * VWorld Engine — TypeScript definitions (v0.5.0).
 *
 *   import { Engine, VWorldError, type QualityMode } from '@vworld/engine';
 *
 * These mirror the runtime public API exported from src/index.js.
 */
import * as THREE from 'three';

/** Anything a position-like API accepts (the normalize-don't-complain law). */
export type Vec3Input =
  | number
  | [number, number, number]
  | number[]
  | { x: number; y?: number; z?: number }
  | THREE.Vector3
  | THREE.Object3D
  | Entity;

/** Plugin contract for `app.use()`. */
export interface VWorldPlugin {
  name: string;
  install(app: Engine, options?: Record<string, unknown>): void;
}

export type EngineEventName = 'tick' | 'render' | 'dispose' | 'contextlost' | 'contextrestored';
export type QualityLevel = 'high' | 'medium' | 'low';
export type QualityMode = QualityLevel | 'auto';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  antialias?: boolean;
  pixelRatio?: number;
  fixedDt?: number;
  maxFrameDt?: number;
  fov?: number;
  near?: number;
  far?: number;
  shadows?: boolean;
  debug?: boolean;
}

/** Machine-readable error codes thrown or reported by the engine. */
export type VWorldErrorCode =
  | 'VWORLD/MISSING_CANVAS'
  | 'VWORLD/APP_DISPOSED'
  | 'VWORLD/BAD_PLUGIN'
  | 'VWORLD/PLUGIN_INSTALL_FAILED'
  | 'VWORLD/UNKNOWN_EVENT'
  | 'VWORLD/EVENT_HANDLER_THREW'
  | 'VWORLD/BAD_HANDLER'
  | 'VWORLD/PHYSICS_NOT_READY'
  | 'VWORLD/BODY_NOT_BOUND'
  | 'VWORLD/BAD_BODY'
  | 'VWORLD/PLUGIN_MISSING'
  | 'VWORLD/UNKNOWN_QUALITY'
  | 'VWORLD/BAD_QUALITY'
  | string;

/**
 * Engine — the core application object.
 *
 *   const app = Engine.create({ canvas }).start();
 */
export class Engine {
  static create(options?: EngineOptions): Engine;
  static EVENTS: EngineEventName[];

  constructor(options?: EngineOptions);

  readonly options: EngineOptions;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly world: World;
  readonly physics: Physics;
  readonly input: Input;
  readonly assets: Assets;
  readonly net: Net;
  readonly build: Build;
  readonly ai: AI;
  readonly time: Time;
  readonly ready: Promise<this>;

  /** Begin the frame loop (waits for Rapier WASM internally). Throws VWORLD/APP_DISPOSED after dispose(). */
  start(): this;
  /** Stop the frame loop. */
  stop(): this;
  /** Full teardown — loop, listeners, entities, renderer. Idempotent. */
  dispose(): this;

  /** Install a plugin: `app.use(AudioPlugin)` or `app.use(AudioPlugin, {...})`. */
  use(plugin: VWorldPlugin, options?: Record<string, unknown>): this;
  /** Is a plugin installed? `app.using('audio')`. */
  using(name: string): boolean;

  /** Subscribe to an engine error (internal catch sites report here). Chainable. */
  onError(fn: (err: Error) => void): this;
  /** Remove a previously registered error handler. Chainable. */
  offError(fn: (err: Error) => void): this;

  /** Toggle debug mode (leak detection on dispose). Chainable. */
  debug(flag?: boolean): this;

  /**
   * Set quality ('high'|'medium'|'low'|'auto' or `{ level }`); no args returns
   * the current effective level. Chainable when setting.
   */
  quality(level: QualityMode | { level: QualityMode }): this;
  quality(): QualityLevel;

  /** The engine profiler — built-in sections 'fixed', 'frame', 'render'. */
  profiler(): Profiler;

  /** Subscribe to an engine lifecycle event. Chainable. */
  on(event: EngineEventName, fn: (dt?: number) => void): this;
  /** Unsubscribe. Chainable. */
  off(event: EngineEventName, fn: (dt?: number) => void): this;

  /** Called every fixed physics tick. Chainable. */
  onFixedUpdate(fn: (dt: number) => void): this;
  /** Called every rendered frame. Chainable. */
  onUpdate(fn: (dt: number) => void): this;
  /** Remove a previously added updater. Chainable. */
  offUpdate(fn: (dt: number) => void): this;

  /** Create an Entity already added to the scene. */
  entity(): Entity;
  /** Add an Entity (or raw Object3D) to the scene. */
  add(thing: Entity | THREE.Object3D): this;

  /**
   * One draw call for many copies (crowds, forests, debris).
   * `app.instanced(geo, mat, 500)` or `app.instanced({ geometry, material, count })`.
   */
  instanced(geometry: THREE.BufferGeometry, material: THREE.Material, count?: number): InstancedSet;
  instanced(options: { geometry: THREE.BufferGeometry; material: THREE.Material; count?: number }): InstancedSet;
  /**
   * A tuned MeshStandardMaterial from the preset library.
   * `app.material('brass')`, `app.material('glass', { opacity: 0.5 })`,
   * or `app.material({ preset: 'wood', color: 'red' })`.
   */
  material(name: MaterialPresetName, overrides?: Record<string, unknown>): THREE.MeshStandardMaterial;
  material(options: { preset: MaterialPresetName } & Record<string, unknown>): THREE.MeshStandardMaterial;
  /**
   * Tune the sun's shadow map; no args returns the current settings.
   * `app.shadows({ mapSize: 4096, bounds: 90 })`. Chainable when applying.
   */
  shadows(options: ShadowOptions): this;
  shadows(): ResolvedShadowConfig;
  /**
   * Stick a decal to a surface (bullet holes, scorch marks).
   * Added to the scene automatically.
   */
  decal(options?: DecalOptions): Decal;
  /** Procedural drifting clouds. Added to the scene automatically. */
  clouds(options?: CloudOptions): CloudLayer;
  /** Fake volumetric light shaft (additive cone). Added to the scene automatically. */
  lightShaft(options?: LightShaftOptions): LightShaft;
  /**
   * The world's quest log (created lazily): define quests, advance
   * objectives, run completion rewards.
   */
  quests(): QuestLog;
  /**
   * Walk a branching dialogue tree (NPC conversations).
   * Returns a fresh Dialogue each call.
   */
  dialogue(tree: DialogueTree): Dialogue;
  /**
   * Screen-space HUD overlay: health bars, prompts, crosshair, objective
   * tracker. Created lazily; no-ops cleanly without a DOM.
   */
  hud(): Hud;
  /** Re-sync renderer size to the canvas. */
  resize(): this;
}

/**
 * Entity — a chainable wrapper around a THREE.Group.
 *
 *   app.entity().box(2, 1, 2, 0x8844ff).at(0, 0.5, 0).rotateY(0.4);
 */
export class Entity {
  constructor(engine?: Engine | null);
  readonly id: string;
  readonly object: THREE.Group;
  readonly engine: Engine | null;
  readonly tags: string[];

  tag(name: string): this;
  untag(name: string): this;
  hasTag(name: string): boolean;

  mesh(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]): this;
  box(w: number, h: number, d: number, color?: number): this;
  sphere(r: number, color?: number, segments?: number): this;
  capsule(radius: number, length: number, color?: number): this;
  cylinder(rTop: number, rBottom: number, height: number, color?: number): this;
  /** Recolor every mesh in this entity. */
  colored(hex: number): this;

  /**
   * Distance-based level of detail. `mesh` per level: THREE.Object3D | Entity | null (hidden).
   * Accepts `{ distance, mesh }` objects or `[distance, mesh]` pairs.
   */
  lod(levels: Array<{ distance: number; mesh: THREE.Object3D | Entity | null } | [number, THREE.Object3D | Entity | null]>): this;
  /** The active LOD level index, or -1 when lod() was never called. */
  readonly lodIndex: number;

  at(...args: Vec3Input[]): this;
  moveBy(...args: Vec3Input[]): this;
  moveTo(dest: Vec3Input, options?: { speed?: number; arrive?: number; onArrive?: (entity: Entity) => void }): this;
  stopMove(): this;
  rotateX(a: number): this;
  rotateY(a: number): this;
  rotateZ(a: number): this;
  rotation(x: number, y: number, z: number): this;
  scale(s: number): this;
  scaleXYZ(x: number, y: number, z: number): this;
  lookAt(...args: Vec3Input[]): this;
  show(): this;
  hide(): this;
  attach(...children: Array<Entity | Entity[]>): this;
  /** Alias kept for v0.1.0 compatibility. */
  child(entity: Entity): this;

  on(event: 'collide' | `collide:${string}` | 'enter' | 'exit', fn: (...args: any[]) => void): this;
  off(event: string, fn: (...args: any[]) => void): this;

  /** Animator for this entity — requires app.use(AnimationPlugin) first. */
  anim(): Animator;
  /** Run `fn(dt, entity)` every rendered frame. Removed on dispose(). */
  onUpdate(fn: (dt: number, entity: Entity) => void): this;

  /**
   * Full teardown: tickers, GPU resources, physics body, scene removal.
   * Idempotent. Chainable.
   */
  dispose(): this;
  /** @deprecated Use dispose() instead. */
  destroy(): this;

  /** Plain-data snapshot for replication. */
  serialize(): { id: string; p: [number, number, number]; q: [number, number, number, number]; s: [number, number, number] };
  /** Apply a snapshot produced by serialize(). */
  applySnapshot(snap: { p?: number[]; q?: number[]; s?: number[] }): this;

  /**
   * This entity's inventory (created lazily on first call).
   * Options ({ capacity, maxSlots }) only apply on first call.
   */
  inventory(options?: { capacity?: number; maxSlots?: number }): Inventory;
  /**
   * This entity's health pool (created lazily on first call).
   * Accepts a max number or { max, hp }.
   */
  health(max?: number | { max?: number; hp?: number }): Health;
}

/** Physics — Rapier (WASM) wrapped in a fluent API. */
export class Physics {
  gravity(x: number, y: number, z?: number): this;
  eachBody(fn: (body: Body) => void): void;
  /** Start building a rigid body. */
  body(): BodyBuilder;
  /** Start building a joint between two bodies. */
  joint(): JointBuilder;
  vehicle(chassisBody: Body, options?: Record<string, unknown>): Vehicle;
  /** Step the simulation (called by the engine loop). */
  step(dt: number): this;
  /** Toggle the Rapier debug renderer overlay. */
  debug(show: boolean): this;
  characterController(offset?: number): unknown;
}

/** Fluent rigid-body builder: `app.physics.body().dynamic().cuboid(1,1,1).at(0,5,0).build()`. */
export class BodyBuilder {
  dynamic(): this;
  static(): this;
  kinematicPosition(): this;
  at(x: number, y: number, z: number): this;
  cuboid(w: number, h: number, d: number): this;
  ball(radius: number): this;
  capsule(halfHeight: number, radius: number): this;
  friction(f: number): this;
  restitution(e: number): this;
  density(d: number): this;
  sensor(v?: boolean): this;
  bind(entity: Entity): this;
  build(): Body;
}

/** A live rigid body in the Rapier world. */
export class Body {
  bind(entity: Entity): this;
  on(event: string, fn: (...args: any[]) => void): this;
  translation(): { x: number; y: number; z: number };
  rotation(): { x: number; y: number; z: number; w: number };
  teleport(x: number, y: number, z: number): this;
  setNextTranslation(x: number, y: number, z: number): this;
  applyImpulse(x: number, y: number, z: number, wake?: boolean): this;
  applyImpulseAtPoint(ix: number, iy: number, iz: number, px: number, py: number, pz: number): this;
  angvel(): { x: number; y: number; z: number };
  setAngvel(x: number, y: number, z: number): this;
  linvel(): { x: number; y: number; z: number };
  setLinvel(x: number, y: number, z: number, wake?: boolean): this;
  setEnabled(enabled: boolean): this;
  /** Remove the rigid body from the physics world. */
  destroy(): this;
}

/** Fluent joint builder: hinge | spring | fixed | ball. */
export class JointBuilder {
  hinge(bodyA: Body, bodyB: Body, options?: Record<string, unknown>): unknown;
  spring(bodyA: Body, bodyB: Body, options?: Record<string, unknown>): unknown;
  fixed(bodyA: Body, bodyB: Body, options?: Record<string, unknown>): unknown;
  ball(bodyA: Body, bodyB: Body, options?: Record<string, unknown>): unknown;
}

/** Arcade vehicle controller. */
export class Vehicle {
  throttle(v: number): this;
  steer(v: number): this;
  stop(): this;
  destroy(): this;
}

/** Input — keyboard/mouse/pointer state. */
export class Input {
  key(code: string): boolean;
  pressed(code: string): boolean;
  released(code: string): boolean;
  axis(negative: string, positive: string): number;
  lockPointer(): void;
  unlockPointer(): void;
  enabled: boolean;

  /**
   * Bind action names to inputs: map({ jump: ['Space', 'gamepad:0'] })
   * or map('jump', ['Space']). Re-calling replaces an action's bindings.
   */
  map(def: Record<string, string | ParsedBinding | Array<string | ParsedBinding> | undefined> | string, bindings?: string | ParsedBinding | Array<string | ParsedBinding>): this;
  /** Remove an action's bindings. */
  unmap(action: string): this;
  /** Action names currently bound. */
  actions(): string[];
  /** Raw parsed bindings for an action (debugging). */
  bindingsFor(action: string): ParsedBinding[];
  /** Is any binding of this action held? */
  action(name: string): boolean;
  /** Was any binding of this action pressed this frame? */
  actionPressed(name: string): boolean;
  /** Was any binding of this action released this frame? */
  actionReleased(name: string): boolean;
  /** -1..1 from two actions, e.g. actionAxis('moveLeft', 'moveRight'). */
  actionAxis(negative: string, positive: string): number;
  /** Is mouse button held? 0=left, 1=middle, 2=right. */
  mouseButton(button: number): boolean;
  /** Snapshot of connected gamepads (empty without navigator). */
  readonly gamepads: Array<{ index: number; buttons: number; axes: number }>;
}

/** PlayerController — kinematic character with camera follow. */
export class PlayerController {
  constructor(engine: Engine, options?: Record<string, unknown>);
  spawn(x: number, y: number, z: number): this;
  speed(v: number): this;
  runSpeed(v: number): this;
  jumpSpeed(v: number): this;
  destroy(): void;
}

/** Assets — cached GLTF/texture loading + character packs. */
export class Assets {
  load(url: string): Promise<unknown>;
  model(url: string): Promise<unknown>;
  texture(url: string): Promise<THREE.Texture>;
  has(url: string): boolean;
  clear(url?: string): void;
  readonly characters: CharacterRegistry;
}

export interface CharacterPackOptions {
  url?: string;
  name?: string;
  factory?: (() => THREE.Group) | null;
}

export class CharacterRegistry {
  registerPack(id: string, options?: CharacterPackOptions): this;
  hasPack(id: string): boolean;
  downloadPack(id: string): Promise<this>;
  removePack(id: string): this;
  list(): string[];
  /** Spawn an avatar — falls back to the built-in default when the pack isn't downloaded. */
  spawn(id: string, options?: { tint?: number }): Promise<THREE.Group>;
}

/** Net — client prediction, interpolation, lag compensation, interest, bandwidth. No transport ships in the engine. */
export interface NetInput { move?: [number, number] | { x: number; z: number } | string; jump?: boolean; sprint?: boolean }
export interface NetState { p: [number, number, number]; v: [number, number, number]; grounded: boolean }
export interface NetSnapshot { id: string; p: [number, number, number]; q: [number, number, number, number]; s?: [number, number, number] }
export interface NetPendingInput { seq: number; input: { move: { x: number; z: number }; jump: boolean; sprint: boolean } }
export interface InterestRuleObject { radius?: number; kinds?: string[]; exclude?: string[] }
export type InterestRule = number | ((entity: unknown, viewer: unknown) => boolean) | InterestRuleObject;
export class Net {
  on(event: string, fn: (data: unknown) => void): this;
  off(event: string, fn: (data: unknown) => void): this;
  emit(event: string, data: unknown): this;
  serialize(entity: Entity): { id: string; p: number[]; q: number[]; s: number[] };
  applySnapshot(entity: Entity, snap: { p?: number[]; q?: number[]; s?: number[] }): this;
  snapshotAll(): unknown[];
  sendRate(hz: number): this;
  predict(entity: Entity, input: NetInput | string | [number, number] | { x: number; z: number }, opts?: { dt?: number; speed?: number; accel?: number; friction?: number; gravity?: number; jumpSpeed?: number; minY?: number; sprintMul?: number }): number;
  ack(entity: Entity, ackSeq: number): this;
  predictionPending(entity: Entity): number;
  correct(entity: Entity, authSnap: { p: [number, number, number]; v?: [number, number, number]; grounded?: boolean }, ackSeq: number, opts?: { dt?: number }): this;
  forgetPrediction(entity: Entity): this;
  interpolate(opts?: { delay?: number; maxBuffer?: number }): Interpolator;
  rewind(opts?: { historyMs?: number; maxSamples?: number }): RewindBuffer;
  interest(rule?: InterestRule): InterestManager;
  relevant(viewer: unknown, entities: unknown[], rule?: InterestRule): unknown[];
  delta(prev: Record<string, NetSnapshot>, next: Record<string, NetSnapshot>, eps?: number): Record<string, unknown>;
  applyDelta(prev: Record<string, NetSnapshot>, d: Record<string, unknown>): Record<string, NetSnapshot>;
  quantize(snap: NetSnapshot, opts?: { posBits?: number; posRange?: number; quatBits?: number }): unknown;
  dequantize(qs: unknown, opts?: { posBits?: number; posRange?: number; quatBits?: number }): NetSnapshot;
  prioritize(viewer: unknown, entities: Array<{ id: string; p: [number, number, number] }>, opts?: { near?: number; mid?: number; nearHz?: number; midHz?: number; farHz?: number }): Array<{ id: string; dist: number; hz: number; interval: number }>;
  connect(url: string): void;
  send(event: string, data: unknown): void;
  disconnect(): void;
}
export class Interpolator {
  constructor(opts?: { delay?: number; maxBuffer?: number });
  push(snap: unknown): this;
  renderTime(now?: number): number;
  sample(now?: number): Record<string, { p: [number, number, number]; q: [number, number, number, number] }>;
  apply(byId: Record<string, Entity>, now?: number): this;
  clear(): this;
}
export class RewindBuffer {
  constructor(opts?: { historyMs?: number; maxSamples?: number });
  push(t: number, positions: Record<string, { p: [number, number, number] } | [number, number, number]>): this;
  at(timestamp: number): Record<string, { p: [number, number, number] }>;
  clear(): this;
}
export class InterestManager {
  constructor(rule?: InterestRule);
  rule(r: InterestRule): this;
  relevant(viewer: unknown, entities: unknown[]): unknown[];
  relevantIds(viewer: unknown, entities: unknown[]): string[];
  for(viewer: unknown): (e: unknown) => boolean;
}
export declare function normalizeNetInput(input: unknown): { move: { x: number; z: number }; jump: boolean; sprint: boolean };
export declare function applyNetInput(state: NetState, input: unknown, dt: number, opts?: Record<string, number>): NetState;
export declare function reconcileNetState(authoritative: { p: [number, number, number]; v?: [number, number, number]; grounded?: boolean }, pendingInputs: NetPendingInput[], dt: number, opts?: Record<string, number>): { state: NetState; applied: number[] };
export declare function quatSlerp(q0: [number, number, number, number], q1: [number, number, number, number], t: number): [number, number, number, number];
export declare function normalizeSnapshot(snap: unknown): { t: number; ents: Record<string, { p: [number, number, number]; q?: [number, number, number, number] }> };
export declare function sampleSnapshots(buffer: unknown[], renderTime: number): Record<string, { p: [number, number, number]; q: [number, number, number, number] }>;
export declare function rewindEntities(history: unknown[], timestamp: number): Record<string, { p: [number, number, number] }>;
export declare function quantizeSnap(snap: NetSnapshot, opts?: Record<string, number>): unknown;
export declare function dequantizeSnap(qs: unknown, opts?: Record<string, number>): NetSnapshot;
export declare function deltaSnap(prev: Record<string, NetSnapshot>, next: Record<string, NetSnapshot>, eps?: number): Record<string, unknown>;
export declare function applyDeltaSnap(prev: Record<string, NetSnapshot>, delta: Record<string, unknown>): Record<string, NetSnapshot>;
export declare function prioritizeUpdates(entities: Array<{ id: string; p: [number, number, number] }>, viewer: unknown, opts?: Record<string, number>): Array<{ id: string; dist: number; hz: number; interval: number }>;
export declare function isRelevant(entity: unknown, viewer: unknown, rule?: InterestRule): boolean;
export declare const PREDICT_DEFAULTS: Record<string, number>;
export declare const QUANTIZE_DEFAULTS: Record<string, number>;
export declare const PRIORITIZE_DEFAULTS: Record<string, number>;

/** Result of Build.pick() / pickScene(): raycast hit with world-space normal. */
export interface PickResult {
  point: THREE.Vector3;
  /** Face normal in world space (up when the hit has no face). */
  normal: THREE.Vector3;
  snapped: THREE.Vector3;
  object: THREE.Object3D;
  distance: number;
}
/** Build — prop-building primitives (grid snapping, ghost preview, picking). */
export class Build {
  gridSize(s: number): this;
  snap(value: number, grid?: number): number;
  ghost(geometry: THREE.BufferGeometry, color?: number): THREE.Mesh;
  clearGhost(mesh: THREE.Mesh): void;
  pick(screenX: number, screenY: number, targets: THREE.Object3D[], options?: { snap?: boolean }): PickResult | null;
  pickScene(screenX: number, screenY: number, options?: Record<string, unknown>): PickResult | null;
  snapVec3(v: THREE.Vector3): THREE.Vector3;
}

/** World — terrain, water, scatter, day/night, fluids, surfaces. */
export class World {
  surfaceKind(name: string, opts?: Record<string, unknown>): this;
  surfaceKinds(): string[];
  fluidType(name: string, def?: Record<string, unknown>): this;
  fluid(options?: Record<string, unknown>): unknown;
  registerKind(name: string, factory: () => Entity): this;
  ground(options?: { size?: number; color?: number }): Entity;
  dayNight(): DayNightCycle;
  post(): PostChain;
  terrain(options?: {
    size?: number;
    resolution?: number;
    height?: (x: number, z: number) => number;
    color?: number;
    colorByHeight?: boolean;
    surface?: Record<string, unknown> | null;
    surfaceRepeat?: number;
  }): Entity;
  groundHeight(x: number, z: number): number;
  water(options?: { level?: number; color?: number; waves?: number; size?: number; opacity?: number }): unknown;
  scatter(kind: string, options?: Record<string, unknown>): unknown;
  biome(name: string, options?: { area?: unknown; color?: number | null }): unknown;
  update(dt: number): void;
  /**
   * Auto-collect pickup zone granting inventory items and/or health,
   * with respawn timer. See PickupOptions.
   */
  pickup(options?: PickupOptions): Pickup;
  /** All live pickups. */
  readonly pickups: Pickup[];
}

export class DayNightCycle {
  speed(seconds: number): this;
  time(t: number): this;
  pause(): this;
  resume(): this;
}

/** AI — steering agents with shape-cast wall sliding. */
export class AI {
  agent(entity: Entity): Agent;
  release(agent: Agent): void;
}

export class Agent {
  speed(v: number): this;
  bodyRadius(r: number): this;
  goto(dest: Vec3Input, options?: { arrive?: number; onArrive?: (agent: Agent) => void }): this;
  wander(area?: Record<string, unknown>): this;
  follow(target: Vec3Input | Entity, dist?: number): this;
  flee(danger: Vec3Input | Entity): this;
  stop(): this;
  state(states: Record<string, AgentStateDef>): this;
  to(name: string): this;
  when(cond: () => boolean, name: string): this;
  distanceToTarget(): number;
}

export interface AgentStateDef {
  enter?: (agent: Agent) => void;
  update?: (dt: number, agent: Agent) => void;
  exit?: (agent: Agent) => void;
}

/** StateMachine — tiny FSM used by AI agents. */
export class StateMachine {
  constructor(states?: Record<string, AgentStateDef>);
  add(name: string, def: AgentStateDef): this;
  to(name: string, ctx?: unknown): this;
  when(cond: (ctx: unknown) => boolean, name: string): this;
  update(dt: number, ctx?: unknown): void;
}

/** Time — scheduling + tweening. */
export class Time {
  after(seconds: number, fn: () => void): TimeHandle;
  every(seconds: number, fn: () => void): TimeHandle;
  tween(entity: Entity): Tween;
}

/** Cancellable handle returned by after()/every(). */
export interface TimeHandle {
  readonly cancelled: boolean;
  cancel(): this;
}

/** Fluent tween: `.to({ at, opacity, scale }, duration).ease('outCubic').then(fn)`. */
export class Tween {
  to(props: { at?: Vec3Input; opacity?: number; scale?: number | [number, number, number] }, duration?: number): this;
  ease(name: string): this;
  then(fn: () => void): this;
  onComplete(fn: () => void): this;
  cancel(): this;
  readonly done: boolean;
}

export declare const EASES: Record<string, (t: number) => number>;
export declare function easeValue(name: string, t: number): number;

/** Plugins — installed via `app.use()`. Core never imports them. */
export declare const AudioPlugin: VWorldPlugin;
export declare const EffectsPlugin: VWorldPlugin;
export declare const PostPlugin: VWorldPlugin;
export declare const AnimationPlugin: VWorldPlugin;
export declare const allPlugins: VWorldPlugin[];

export interface AudioEngineLike {
  register(name: string, url: string): void;
  has(name: string): boolean;
  play(name: string, options?: Record<string, unknown>): void;
  ambient(target: unknown, options?: { volume?: number }): void;
  zone(box: unknown, preset?: string): void;
  volume(v: number): this;
  mute(m?: boolean): this;
  dispose(): void;
}

export interface Animator {
  play(name: string, options?: Record<string, unknown>): this;
  stop(): this;
}

/** Post-processing chain — `app.world.post().bloom(0.6).vignette(0.35)`. */
export class PostChain {
  bloom(amount: number): this;
  vignette(amount: number): this;
  preset(name: string): this;
  enabled: boolean;
  render(): void;
}

// --- Surfaces (v0.3.0) ----------------------------------------------------------

export declare const MAX_SURFACE_LAYERS: number;
export declare function valueNoise(x: number, y: number): number;
export interface SurfaceRuleContext {
  x: number;
  z: number;
  height: number;
  slope: number;
  fluids: unknown[];
}
export declare function evaluateRuleWeight(rule: Record<string, unknown>, ctx: SurfaceRuleContext): number;
export declare function compositeWeights(raw: number[]): number[];
export declare class SurfaceKinds {
  register(name: string, def: Record<string, unknown>): this;
  get(name: string): Record<string, unknown> | undefined;
  names(): string[];
}
export declare function buildAtlas(kindNames: string[], kinds: SurfaceKinds): THREE.Texture;
export declare function buildSplatMaterial(
  kindDefs: Record<string, unknown>[],
  options?: { repeat?: number; atlasTexture?: THREE.Texture | null }
): THREE.ShaderMaterial;

// --- Fluids (v0.3.0) ------------------------------------------------------------

export declare const BUILTIN_FLUID_TYPES: Record<string, Record<string, unknown>>;
export declare function submergedFraction(
  aabb: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
): number;
export declare function buoyancyNetAccel(fluidDensity: number, bodyDensity: number, fraction: number, g?: number): number;
export declare class Fluid {
  constructor(options?: Record<string, unknown>);
  onEnter(fn: (entity: Entity) => void): this;
  onExit(fn: (entity: Entity) => void): this;
  dispose(): void;
}
export declare class FluidSystem {
  add(fluid: Fluid): this;
  remove(fluid: Fluid): this;
  update(dt: number): void;
}

// --- normalize utils ------------------------------------------------------------

export declare function toVec3(...args: Vec3Input[]): THREE.Vector3;
export declare function toXYZ(...args: Vec3Input[]): { x: number; y: number; z: number };
export declare function toNumber(v: unknown, name?: string, fallback?: number): number;
export declare function withDefaults<T extends Record<string, unknown>>(options: Partial<T> | undefined, defaults: T): T;
export declare function toAxis(v: unknown, name?: string): 'x' | 'y' | 'z';
export declare function axisToVec3(axis: unknown): THREE.Vector3;
export declare function toBox3(v: unknown, name?: string): THREE.Box3;

// --- production hardening (v0.4.0) ------------------------------------------------

/**
 * Base class for every engine-thrown error. Carries a machine-readable `.code`
 * like 'VWORLD/PHYSICS_NOT_READY'.
 */
export declare class VWorldError extends Error {
  readonly code: VWorldErrorCode;
  constructor(code: VWorldErrorCode, message: string, opts?: { cause?: unknown });
}

/** Shorthand factory for VWorldError. */
export declare function vError(code: VWorldErrorCode, message: string, opts?: { cause?: unknown }): VWorldError;

/** Pure, testable error bus (see createErrorBus). */
export interface ErrorBus {
  onError(fn: (err: Error) => void): ErrorBus;
  offError(fn: (err: Error) => void): ErrorBus;
  report(err: unknown): ErrorBus;
}

/**
 * Pure, testable error bus. Handlers run in registration order; with no
 * handlers, errors fall back to `console.error`.
 */
export declare function createErrorBus(): ErrorBus;

/** Report through the engine's error bus (falls back to console.error). Internal. */
export declare function reportError(engine: { _errorBus?: ErrorBus } | null | undefined, err: unknown): void;

/** Zero-dependency frame-time profiler. */
export declare class Profiler {
  constructor(options?: { enabled?: boolean; windowSize?: number });
  /** Master switch — when false, begin()/end() are no-ops. */
  enabled: boolean;
  /** Start timing a named section. Chainable. */
  begin(name: string): this;
  /** Stop timing a named section and record the sample. Chainable. */
  end(name: string): this;
  /** Record an explicit sample. Chainable. */
  record(name: string, ms: number): this;
  /** Stats per section over the rolling window. */
  report(): Record<string, { avgMs: number; maxMs: number; calls: number }>;
  /** Clear all samples and call counts. Chainable. */
  reset(): this;
  /** One-line human summary, e.g. `fixed: avg 0.42ms max 1.10ms (60 calls)`. */
  summary(): string;
}

/** All supported quality level names, high → low. */
export declare const QUALITY_LEVELS: readonly ['high', 'medium', 'low'];

/**
 * Resolve a quality level + devicePixelRatio into concrete renderer settings.
 * 'auto' resolves to high settings (runtime stepping adjusts it later).
 */
export declare function resolveQuality(
  level: QualityMode,
  dpr?: number
): { pixelRatio: number; shadows: boolean };

/** Normalize an app.quality() argument into a level name. */
export declare function normalizeQuality(v: QualityMode | { level: QualityMode }): QualityMode;

/**
 * Pure auto-quality stepping rule: returns the new level and the updated
 * consecutive-high-FPS streak.
 */
export declare function autoStep(
  currentLevel: QualityLevel,
  avgFps: number,
  highStreak?: number
): { level: QualityLevel; highStreak: number };

/** All material preset names. */
export type MaterialPresetName =
  | 'metal' | 'chrome' | 'gold' | 'brass' | 'copper' | 'glass' | 'water'
  | 'plastic' | 'rubber' | 'wood' | 'stone' | 'grass' | 'paper' | 'emissive';

/** Anything a color-like API accepts. */
export type ColorInput = number | string | THREE.Color | { r: number; g: number; b: number };

/** Normalize any color-like input into a fresh THREE.Color. */
export declare function toColor(v: ColorInput, name?: string): THREE.Color;

/** Tuned MeshStandardMaterial parameter sets, keyed by preset name. */
export declare const MATERIAL_PRESETS: Record<MaterialPresetName, Record<string, unknown>>;
/** All material preset names. */
export declare function materialPresetNames(): MaterialPresetName[];
/** Resolve a preset name (case-insensitive) + overrides into plain material params. */
export declare function resolveMaterialPreset(name: string, overrides?: Record<string, unknown>): Record<string, unknown>;
/** Build a THREE.MeshStandardMaterial from a preset name + overrides. */
export declare function makeMaterial(name: string, overrides?: Record<string, unknown>): THREE.MeshStandardMaterial;

/** Options for app.shadows(). */
export interface ShadowOptions {
  mapSize?: number | [number, number];
  bias?: number;
  normalBias?: number;
  radius?: number;
  bounds?: number | { left?: number; right?: number; top?: number; bottom?: number };
  near?: number;
  far?: number;
}
/** Normalized shadow settings. */
export interface ResolvedShadowConfig {
  mapSize: [number, number];
  bias: number; normalBias: number; radius: number;
  left: number; right: number; top: number; bottom: number;
  near: number; far: number;
}
/** Normalize shadow settings into a plain config object. */
export declare function resolveShadowConfig(options?: ShadowOptions): ResolvedShadowConfig;

/** One LOD level: `{ distance, mesh }` or `[distance, mesh]`. */
export type LodLevel =
  | { distance: number; mesh: THREE.Object3D | Entity | null }
  | [number, THREE.Object3D | Entity | null];
/** Normalize LOD levels into a sorted [{ distance, mesh }] array. */
export declare function normalizeLodLevels(levels: LodLevel[]): Array<{ distance: number; mesh: THREE.Object3D | null }>;
/** Pick the active LOD level index for a camera distance. */
export declare function selectLod(distance: number, levels: Array<{ distance: number; mesh?: unknown }>): number;

/** Options for app.decal(). */
export interface DecalOptions {
  texture?: THREE.Texture | null;
  preset?: 'scorch' | 'bullet';
  position?: Vec3Input;
  normal?: Vec3Input;
  size?: number | [number, number] | { w?: number; h?: number; width?: number; height?: number };
  lifetime?: number;
  fade?: number;
  opacity?: number;
  color?: ColorInput;
}
/** Compute a decal quad's placement frame. */
export declare function decalFrame(
  position: Vec3Input, normal: Vec3Input, size?: number | [number, number] | { w?: number; h?: number }
): { position: THREE.Vector3; quaternion: THREE.Quaternion; width: number; height: number };
/** Opacity multiplier for a decal's age (1 → 0 over the fade window). */
export declare function decalOpacity(age: number, lifetime: number, fade?: number): number;
/** Procedural scorch-mark texture (needs DOM). */
export declare function scorchTexture(size?: number): THREE.Texture;
/** Procedural bullet-hole texture (needs DOM). */
export declare function bulletTexture(size?: number): THREE.Texture;
/** Decal preset names: 'scorch' | 'bullet'. */
export declare function decalPresetNames(): string[];

/** A quad stuck to a surface, with optional lifetime + fade. */
export declare class Decal {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  readonly lifetime: number;
  readonly fade: number;
  age: number;
  constructor(engine: Engine | null, options?: DecalOptions);
  addTo(appOrScene: Engine | THREE.Scene): this;
  dispose(): this;
}

/** Frame for a shaft running from `from` (narrow) to `to` (wide). */
export declare function shaftFrame(from: Vec3Input, to: Vec3Input): {
  midpoint: THREE.Vector3; quaternion: THREE.Quaternion; length: number; direction: THREE.Vector3;
};
/** Options for app.lightShaft(). */
export interface LightShaftOptions {
  from?: Vec3Input; to?: Vec3Input; radius?: number;
  color?: ColorInput; intensity?: number; segments?: number;
}
/** Fake volumetric light shaft (additive cone). */
export declare class LightShaft {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  constructor(engine: Engine | null, options?: LightShaftOptions);
  intensity(v: number): this;
  addTo(appOrScene: Engine | THREE.Scene): this;
  dispose(): this;
}

/** Deterministic cloud puff layout: [{ x, y, z, scale }]. */
export declare function cloudLayout(
  count?: number,
  area?: number | { x?: number; z?: number },
  height?: number | [number, number],
  scale?: number | [number, number],
  seed?: number
): Array<{ x: number; y: number; z: number; scale: number }>;
/** Soft radial puff texture for cloud sprites (needs DOM). */
export declare function cloudTexture(size?: number): THREE.Texture;
/** Options for app.clouds(). */
export interface CloudOptions {
  count?: number; area?: number | { x?: number; z?: number };
  height?: number | [number, number]; speed?: number;
  scale?: number | [number, number]; opacity?: number; seed?: number; color?: ColorInput;
}
/** Procedural drifting clouds (needs DOM). */
export declare class CloudLayer {
  readonly speed: number;
  constructor(engine: Engine | null, options?: CloudOptions);
  update(dt: number): this;
  addTo(appOrScene: Engine | THREE.Scene): this;
  dispose(): this;
}

/** Per-instance transform options for InstancedSet.set(). */
export interface InstanceTransform {
  at?: Vec3Input;
  scale?: number | Vec3Input;
  rotate?: [number, number, number] | { x?: number; y?: number; z?: number };
}
/** Options for InstancedSet.scatter(). */
export interface ScatterOptions {
  box?: [number, number] | { x?: [number, number]; z?: [number, number] };
  count?: number;
  y?: number | [number, number];
  scale?: number | [number, number];
  spin?: [number, number];
}
/** One draw call for many copies: crowds, forests, debris. */
export declare class InstancedSet {
  readonly mesh: THREE.InstancedMesh;
  readonly count: number;
  constructor(engine: Engine | null, geometry: THREE.BufferGeometry, material: THREE.Material, count?: number);
  set(i: number, transform?: InstanceTransform): this;
  scatter(options?: ScatterOptions): this;
  update(): this;
  at(...args: Vec3Input[]): this;
  moveBy(...args: Vec3Input[]): this;
  shadows(on?: boolean): this;
  addTo(appOrScene: Engine | THREE.Scene): this;
  dispose(): this;
}

/** Gameplay systems (v0.7.0). */

export type ItemInput = string | { id?: string; item?: string; name?: string; qty?: number; count?: number };

export interface InventoryChangeEvent {
  item: string | null;
  qty: number;
  delta: number;
  total: number;
  action: 'add' | 'remove' | 'clear';
}

export class Inventory {
  constructor(options?: { capacity?: number; maxSlots?: number }, engine?: Engine | null);
  readonly slots: number;
  readonly total: number;
  on(event: 'change', fn: (e: InventoryChangeEvent) => void): this;
  off(event: 'change', fn: (e: InventoryChangeEvent) => void): this;
  count(item: ItemInput): number;
  has(item: ItemInput, qty?: number): boolean;
  list(): Array<{ item: string; qty: number }>;
  add(item: ItemInput, qty?: number): number;
  remove(item: ItemInput, qty?: number): number;
  clear(): this;
}

export interface HealthEvent {
  amount: number;
  hp: number;
  max: number;
  source?: unknown;
}

export class Health {
  constructor(max?: number | { max?: number; hp?: number }, engine?: Engine | null);
  readonly hp: number;
  readonly max: number;
  readonly dead: boolean;
  readonly fraction: number;
  on(event: 'damage' | 'heal' | 'death', fn: (e: HealthEvent) => void): this;
  off(event: string, fn: (...args: any[]) => void): this;
  damage(amount: number, source?: unknown): number;
  heal(amount: number): number;
}

export interface QuestObjectiveDef {
  id?: string;
  text?: string;
  target?: number;
}

export interface QuestDef {
  id?: string;
  name?: string;
  objectives: Array<string | QuestObjectiveDef>;
  reward?: (quest: QuestSummary) => void;
}

export interface QuestObjectiveState {
  id: string;
  text: string;
  target: number;
  count: number;
  done: boolean;
}

export interface QuestSummary {
  id: string;
  name: string;
  state: 'locked' | 'active' | 'complete';
  objectives: QuestObjectiveState[];
}

export type QuestState = 'unknown' | 'locked' | 'active' | 'complete';

export class QuestLog {
  constructor(engine?: Engine | null);
  on(event: 'start' | 'objective' | 'complete', fn: (e: { quest: QuestSummary; objective?: QuestObjectiveState }) => void): this;
  off(event: string, fn: (...args: any[]) => void): this;
  define(def: QuestDef): this;
  state(id: string): QuestState;
  start(id: string): this;
  advance(questId: string, objectiveId: string, n?: number): this;
  objective(questId: string, objectiveId: string): QuestObjectiveState | null;
  reset(id: string): this;
  list(): QuestSummary[];
}

export interface DialogueChoice {
  id?: string | null;
  text: string;
  to?: string | null;
}

export interface DialogueNodeDef {
  text?: string;
  choices?: Array<string | DialogueChoice>;
  onEnter?: (dialogue: Dialogue) => void;
}

export interface DialogueTree {
  start?: string;
  nodes: Record<string, string | DialogueNodeDef>;
}

export interface DialogueNode {
  id: string;
  text: string;
  choices: DialogueChoice[];
}

export class Dialogue {
  constructor(tree: DialogueTree, engine?: Engine | null);
  on(event: 'node' | 'choice' | 'end', fn: (e: any) => void): this;
  off(event: string, fn: (...args: any[]) => void): this;
  node(): DialogueNode | null;
  readonly ended: boolean;
  choose(sel: number | string): DialogueNode | null;
  reset(): this;
}

export type ParsedBinding =
  | { type: 'key'; code: string }
  | { type: 'mouse'; button: number }
  | { type: 'padButton'; pad: number; button: number }
  | { type: 'padAxis'; pad: number; axis: number; dir: -1 | 0 | 1 };

export interface KeyState {
  keys: Set<string>;
  pressed: Set<string>;
  released: Set<string>;
  mouse: Set<number>;
  mousePressed: Set<number>;
  mouseReleased: Set<number>;
}

export interface PadState {
  buttons: boolean[];
  pressed: boolean[];
  released: boolean[];
  axes: number[];
}

export declare function normalizeItemId(item: ItemInput): string;
export declare function parseBinding(str: string): ParsedBinding;
export declare function normalizeBindings(input: string | ParsedBinding | Array<string | ParsedBinding>): ParsedBinding[];
export declare function bindingHeld(b: ParsedBinding, kb: KeyState, pads?: Array<PadState | null>): boolean;
export declare function bindingPressed(b: ParsedBinding, kb: KeyState, pads?: Array<PadState | null>): boolean;
export declare function bindingReleased(b: ParsedBinding, kb: KeyState, pads?: Array<PadState | null>): boolean;
export declare function actionHeld(bindings: ParsedBinding[], kb: KeyState, pads?: Array<PadState | null>): boolean;
export declare function actionPressed(bindings: ParsedBinding[], kb: KeyState, pads?: Array<PadState | null>): boolean;
export declare function actionReleased(bindings: ParsedBinding[], kb: KeyState, pads?: Array<PadState | null>): boolean;
export declare function inPickupRange(
  center: { x?: number; y?: number; z?: number },
  radius: number,
  point: { x?: number; y?: number; z?: number }
): boolean;

export interface PickupOptions {
  kind?: string;
  at?: Vec3Input;
  radius?: number;
  item?: ItemInput | null;
  amount?: number;
  heal?: number;
  respawn?: number;
  onCollect?: (e: { pickup: Pickup; entity: Entity; granted: { item: string | null; amount: number; heal: number } }) => void;
  mesh?: boolean | THREE.Object3D;
  spin?: boolean;
  bob?: boolean;
}

export class Pickup {
  constructor(world?: World | null, options?: PickupOptions);
  readonly kind: string;
  readonly radius: number;
  readonly active: boolean;
  grantsFor(): { item: string | null; amount: number; heal: number };
  collectBy(entity: Entity): { item: string | null; amount: number; heal: number } | null;
  tick(dt: number): void;
  dispose(): this;
}

export class Hud {
  constructor(engine?: Engine | null);
  readonly supported: boolean;
  bar(name: string, fraction: number, options?: { label?: string; color?: string; width?: number }): this;
  removeBar(name: string): this;
  prompt(text: string): this;
  clearPrompt(): this;
  crosshair(show?: boolean): this;
  objective(text: string): this;
  clearObjective(): this;
  show(): this;
  hide(): this;
  dispose(): this;
}

/** Engine version. */
export declare const VERSION: string;
