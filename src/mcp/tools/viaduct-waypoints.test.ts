import { describe, it, expect } from 'vitest'
import { endpoints } from '../../rest/table.js'
import { getViaductWaypointsSchema } from './viaduct-waypoints.js'

describe('get_viaduct_waypoints', () => {
  it('is served over REST, which is how msge.no names its map sections', () => {
    const ep = endpoints.find((e) => e.path === '/viaduct-waypoints')
    expect(ep?.name).toBe('get_viaduct_waypoints')
  })

  it('takes no paging: the whole set is the useful answer', () => {
    expect(Object.keys(getViaductWaypointsSchema.shape)).toEqual(['name'])
  })
})
