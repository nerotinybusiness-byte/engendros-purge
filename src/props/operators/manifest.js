// manifest.js — operator vocabulary as pure data (no impl, no THREE).
//   args:   required arg keys.
//   dims:   the subset of args that are REAL-WORLD dimensions → any part using this
//           operator must carry an `src` provenance citation (no invented sizes).
//   anchor: where the part's `at` sits — 'floor' = at is the BOTTOM-centre,
//           'center' = at is the volumetric centre. Mixing these up is the #1
//           placement bug; check here before authoring.
export const MANIFEST = {
  // structural (box-only, pure)
  bevelBox:    { args: ['w', 'h', 'd'],          dims: ['w', 'h', 'd'],        anchor: 'center' },
  panel:       { args: ['w', 'h'],               dims: ['w', 'h'],             anchor: 'center' },
  plate:       { args: ['w', 'd'],               dims: ['w', 'd'],             anchor: 'center' },
  stencil:     { args: ['w', 'h'],               dims: ['w', 'h'],             anchor: 'center' },
  planks:      { args: ['w', 'h', 'd', 'count'], dims: ['w', 'h', 'd'],        anchor: 'floor'  },
  finSet:      { args: ['count', 'root', 'span'], dims: ['root', 'span'],      anchor: 'center' },
  latticeBeam: { args: ['len', 'w', 'h'],        dims: ['len', 'w', 'h'],      anchor: 'center' },
  cabinet:     { args: ['w', 'h', 'd'],          dims: ['w', 'h', 'd'],        anchor: 'center' },
  // furniture (box-only, pure)
  drawerStack: { args: ['w', 'h', 'd', 'count'], dims: ['w', 'h', 'd'],        anchor: 'floor'  },
  legs:        { args: ['w', 'd', 'h'],          dims: ['w', 'd', 'h'],        anchor: 'floor'  },
  // containers/hardware (box-only, pure)
  lidBox:      { args: ['w', 'h', 'd', 'lid'],   dims: ['w', 'h', 'd', 'lid'], anchor: 'floor'  },
  strapBand:   { args: ['w', 'h', 'd'],          dims: ['w', 'h', 'd'],        anchor: 'center' },
  handleU:     { args: ['w', 'h'],               dims: ['w', 'h'],             anchor: 'floor'  },
  // round (THREE-bound — browser-verified, not node-tested)
  cylinder:    { args: ['r', 'h'],                dims: ['r', 'h'],            anchor: 'center' },
  disc:        { args: ['r'],                     dims: ['r'],                 anchor: 'center' },
  cone:        { args: ['r', 'h'],                dims: ['r', 'h'],            anchor: 'center' },
  deltaFins:   { args: ['count', 'root', 'span'], dims: ['root', 'span'],      anchor: 'center' },
  texturedCylinder: { args: ['r', 'h'],           dims: ['r', 'h'],            anchor: 'center' },
  torus:       { args: ['r', 'tube'],             dims: ['r', 'tube'],         anchor: 'center' },
  tube:        { args: ['pts', 'tube'],           dims: ['tube'],              anchor: 'center' },
  texturedDisc: { args: ['r'],                     dims: ['r'],                anchor: 'center' },
  decal:       { args: ['w', 'h'],                dims: ['w', 'h'],            anchor: 'center' },
  texturedPanel: { args: ['w', 'h'],              dims: ['w', 'h'],            anchor: 'center' },
  loaf:        { args: ['w', 'h', 'd'],           dims: ['w', 'h', 'd'],       anchor: 'center' },
  // P-37 radar (structural mesh/emblem + round running-gear/pipework/mast)
  meshReflector:{ args: ['w', 'h'],               dims: ['w', 'h'],            anchor: 'center' },
  star:        { args: ['r'],                     dims: ['r'],                 anchor: 'center' },
  wheel:       { args: ['r', 'w'],                dims: ['r', 'w'],            anchor: 'center' },
  pipe:        { args: ['pts', 'r'],              dims: ['r'],                 anchor: 'center' },
  tubeMast:    { args: ['baseW', 'baseD', 'h'],   dims: ['baseW', 'baseD', 'h'], anchor: 'floor' },
};

export const operatorNames = () => Object.keys(MANIFEST);
