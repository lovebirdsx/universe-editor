// Domain wire DTOs: the JSON shapes that cross the contributed-command / IPC
// boundary between the renderer and each feature's extension (SCM, git graph,
// perforce graph, swarm reviews, blame, dirty-diff, AI). These are the single
// source of truth first-party extensions alias locally (see task 04·1).
export * from './scmWire.js'
export * from './aiWire.js'
export * from './gitGraph.js'
export * from './perforceGraph.js'
export * from './swarm.js'
export * from './blame.js'
export * from './dirtyDiff.js'
