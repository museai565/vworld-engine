import * as THREE from 'three';

/**
 * Build — helpers for the prop-building tools coming in Phase 2.
 *
 *   app.build.gridSize(1);                 // 1m snapping grid
 *   const p = app.build.snapVec3(hitPoint); // snap a Vector3 to the grid
 *   const ghost = app.build.ghost(new THREE.BoxGeometry(1,1,1)); // preview mesh
 *   ghost.position.copy(p);                 // follows the cursor until placed
 *
 * Nothing here places real objects yet — these are the primitives the
 * building tools will be composed from (snapping, ghost previews,
 * raycast picking).
 */
export class Build {
  constructor(engine) {
    this.engine = engine;
    this._grid = 1;
    this._raycaster = new THREE.Raycaster();
  }

  /** Set the snapping grid size in meters. Chainable. */
  gridSize(s) {
    this._grid = Math.max(0.01, s);
    return this;
  }

  get grid() {
    return this._grid;
  }

  /** Snap a single number to the grid. */
  snap(value, grid = this._grid) {
    return Math.round(value / grid) * grid;
  }

  /** Snap a Vector3 to the grid (returns a new Vector3). */
  snapVec3(v, grid = this._grid) {
    return new THREE.Vector3(
      this.snap(v.x, grid),
      this.snap(v.y, grid),
      this.snap(v.z, grid)
    );
  }

  /**
   * Create a translucent "ghost" preview mesh for placement.
   * Position it each frame (e.g. from pick()) and add the real prop on click.
   */
  ghost(geometry, color = 0x35e08a) {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.userData.isGhost = true;
    this.engine.scene.add(mesh);
    return mesh;
  }

  /** Remove a ghost preview from the scene and dispose it. */
  clearGhost(mesh) {
    if (!mesh) return this;
    mesh.removeFromParent();
    mesh.geometry?.dispose();
    mesh.material?.dispose();
    return this;
  }

  /**
   * Raycast from a screen position (pixels, relative to canvas) against
   * target objects. Returns { point, normal, snapped, object, distance }
   * or null. `normal` is the face normal in world space (up when unknown).
   */
  pick(screenX, screenY, targets, { snap = true } = {}) {
    const canvas = this.engine.options.canvas;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((screenX - rect.left) / rect.width) * 2 - 1,
      -((screenY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(ndc, this.engine.camera);
    const hits = this._raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    const hit = hits[0];
    const point = hit.point.clone();
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    return {
      point,
      normal,
      snapped: snap ? this.snapVec3(point) : point,
      object: hit.object,
      distance: hit.distance,
    };
  }

  /** Shortcut: pick against everything currently in the scene. */
  pickScene(screenX, screenY, options) {
    return this.pick(screenX, screenY, this.engine.scene.children, options);
  }
}
