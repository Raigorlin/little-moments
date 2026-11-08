/**
 * Entries the Trip_Menu shows for this state and account.
 * account is null in the local (demo) build.
 * Pure: no DOM access, so it loads under `bun test`.
 */
export function tripMenuEntries(state, account) {
  const perms = account?.permissions;
  return {
    trip: { action: 'trip-settings' },
    people: state.people.map(p => ({
      id: p.id,
      isMe: p.id === state.currentUser,
      // Same rule crew() used: only account members with edit rights, for themselves or as managers.
      canEdit: !!(perms?.canEdit && (perms.canManage || p.id === perms.personId))
    })),
    addPerson: { action: 'person' },
    switchIdentity: { action: 'profile' },
    vehicles: state.vehicles.map(v => ({
      id: v.id,
      edit: { action: 'vehicle' },
      // Same rule crew() used; `=== true` matches the allowAccountAction gate.
      canDelete: !account || perms?.canDelete === true
    })),
    addVehicle: { action: 'vehicle' },
    data: ['export', 'import', 'print'],
    events: state.events.slice(0, 8),
    reset: { action: 'reset' }
  };
}
