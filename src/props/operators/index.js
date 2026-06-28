// index.js — operator name → impl. buildSpec dispatches through this map.
// (index.js is imported only by voxel-interp.js, the THREE side — so re-exporting the
// THREE-bound round operators here does NOT pull `three` into any node-tested module.
// Node-tested code imports the pure impl files directly, never this index.)
export { bevelBox, panel, plate, stencil, planks, finSet, latticeBeam, cabinet, meshReflector, star } from './structural.js';
export { drawerStack, legs } from './furniture.js';
export { lidBox, strapBand, handleU } from './container.js';
export { cylinder, disc, cone, deltaFins, texturedCylinder, torus, tube, texturedDisc, decal, texturedPanel, loaf, wheel, pipe, tubeMast } from './round.js';
