// Vehicle participation is optional so old exports remain valid without migration.
export function validActivityVehicles(activity, vehicles) {
  if (activity.vehicleIds === undefined) return true;
  const ids = activity.vehicleIds;
  return Array.isArray(ids) && ids.length > 0 && ids.length <= vehicles.length
    && new Set(ids).size === ids.length
    && ids.every(id => typeof id === 'string' && vehicles.some(v => v.id === id))
    && Array.isArray(activity.people) && activity.people.length === 0;
}

const occupants = vehicle => [vehicle.driver, ...vehicle.passengers].filter(Boolean);
export function activityForVehicle(state, activity, vehicleId) {
  const vehicle = state.vehicles.find(v => v.id === vehicleId);
  if (!vehicle) return false;
  if (activity.vehicleIds !== undefined) return activity.vehicleIds.includes(vehicleId);
  return activity.people.length === 0 || occupants(vehicle).some(id => activity.people.includes(id));
}

export function activityForPerson(state, activity, personId) {
  if (activity.vehicleIds !== undefined) {
    return state.vehicles.some(v => activity.vehicleIds.includes(v.id) && occupants(v).includes(personId));
  }
  return activity.people.length === 0 || activity.people.includes(personId);
}

export function activityParticipantLabel(state, activity) {
  if (activity.vehicleIds !== undefined) {
    return activity.vehicleIds.map(id => state.vehicles.find(v => v.id === id)?.name || '車輛待確認').join('、');
  }
  if (!activity.people.length || state.people.every(p => activity.people.includes(p.id))) return '全體旅伴';
  return activity.people.map(id => state.people.find(p => p.id === id)?.name || '旅伴待確認').join('、');
}
