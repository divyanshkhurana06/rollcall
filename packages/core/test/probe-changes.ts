import 'dotenv/config'
import { recentAttestations, readArchive } from '../../../apps/api/src/hcs.js'
const a = await readArchive(undefined, 100)
console.log('readArchive(undefined,100):', a.available, (a as any).reason, a.messages.length)
const f = await recentAttestations(5)
console.log('recent:', f.available, f.recent.length, f.recent.slice(0, 2).map((r: any) => ({ seq: r.sequenceNumber, target: r.target?.slice(0, 10), changes: r.changes.length })))
