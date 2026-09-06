import { ProxyCreation } from '../generated/SafeFactory/SafeProxyFactory'
import { Safe } from '../generated/templates'
import { Contract } from '../generated/schema'

/** Every Safe ever deployed becomes a tracked datasource. */
export function handleProxyCreation(event: ProxyCreation): void {
  let id = 'ethereum:' + event.params.proxy.toHex()
  let c = new Contract(id)
  c.address = event.params.proxy
  c.chain = 'ethereum'
  c.kind = 'safe'
  c.firstSeenAt = event.block.timestamp
  c.save()
  Safe.create(event.params.proxy)
}
