// Read models: what each portal is allowed to see.
import type { Accounts, PortalView, Role } from '../../shared/types.ts';
import { aiStatus } from './ai.ts';
import { agenticorgStatus } from './agenticorg.ts';
import { HttpError } from './commands.ts';
import { loadAgentRuns, loadMessages, loadNotifications, loadWorld } from './db.ts';

export function portalView(role: Role, partyId: string): PortalView {
  const w = loadWorld();
  let { orders, retailers, stock } = w;

  if (role === 'distributor') {
    if (!w.suppliers.some((s) => s.id === partyId && s.kind === 'distributor'))
      throw new HttpError(404, `Distributor ${partyId} not found`);
    orders = orders.filter((o) => o.distributorId === partyId);
    // A distributor sees the retailers it serves, including their shelf stock (needed for prioritising).
    const served = new Set([...retailers.filter((r) => r.distributorIds.includes(partyId)).map((r) => r.id), ...orders.map((o) => o.retailerId)]);
    retailers = retailers.filter((r) => served.has(r.id));
    stock = stock.filter((s) => served.has(s.retailerId));
  } else {
    if (!retailers.some((r) => r.id === partyId)) throw new HttpError(404, `Retailer ${partyId} not found`);
    orders = orders.filter((o) => o.retailerId === partyId);
    retailers = retailers.filter((r) => r.id === partyId);
    stock = stock.filter((s) => s.retailerId === partyId);
  }

  return {
    ...w,
    role,
    partyId,
    orders,
    retailers,
    stock,
    notifications: loadNotifications(role, partyId),
    messages: loadMessages(orders.map((o) => o.id)),
    ai: aiStatus(),
    agenticorg: agenticorgStatus(),
    agentRuns: role === 'distributor' ? loadAgentRuns(partyId) : [],
  };
}

export function accounts(): Accounts {
  const w = loadWorld();
  return {
    distributors: w.suppliers.filter((s) => s.kind === 'distributor').map(({ id, name, city }) => ({ id, name, city })),
    retailers: w.retailers.map(({ id, name, area }) => ({ id, name, area })),
  };
}
