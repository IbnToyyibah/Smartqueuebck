const { getSupabase } = require('../config/supabase')

const db = () => {
  const client = getSupabase()
  if (!client) throw new Error('Supabase not initialized')
  return client
}

const isBlank = (v) => v === '' || v === null || v === undefined

// PostgREST "no rows" and Postgres "invalid input syntax" (e.g. a malformed uuid)
// both mean the record does not exist from the caller's point of view.
const NOT_FOUND_CODES = new Set(['PGRST116', '22P02'])

const applyFilters = (q, table, filters) => {
  filters.forEach(([col, op, value]) => {
    // A blank filter value used to be skipped silently, which turned a scoped
    // query (e.g. "tickets for branch X") into a full-table read. Fail loudly instead.
    if (isBlank(value)) {
      throw Object.assign(new Error(`Missing value for filter "${col}" on ${table}.`), { statusCode: 400 })
    }
    switch (op) {
      case 'eq': q = q.eq(col, value); break
      case 'neq': q = q.neq(col, value); break
      case 'in': q = q.in(col, value); break
      case 'ilike': q = q.ilike(col, value); break
      case 'gte': q = q.gte(col, value); break
      case 'lte': q = q.lte(col, value); break
      default: throw new Error(`Unsupported filter operator "${op}".`)
    }
  })
  return q
}

const findById = async (table, id, columns = '*') => {
  if (isBlank(id)) return null

  const { data, error } = await db().from(table).select(columns).eq('id', id).single()

  if (error) {
    if (NOT_FOUND_CODES.has(error.code)) return null
    throw error
  }
  return data
}

const findMany = async (table, { select = '*', filters = [], order = null, limit = null, range = null } = {}) => {
  let q = applyFilters(db().from(table).select(select), table, filters)

  if (order) q = q.order(order.column, { ascending: order.ascending ?? true })
  if (range) q = q.range(range.from, range.to)
  if (limit) q = q.limit(limit)

  const { data, error } = await q
  if (error) throw error
  return data || []
}

const insert = async (table, values, select = '*') => {
  const { data, error } = await db().from(table).insert(values).select(select)
  if (error) throw error
  return Array.isArray(data) ? data[0] : data
}

const updateById = async (table, id, values, select = '*') => {
  if (isBlank(id)) return null

  const { data, error } = await db().from(table).update(values).eq('id', id).select(select)
  if (error) throw error
  return Array.isArray(data) ? data[0] : data
}

// Bulk update every row matching the filters in a single round trip.
const updateWhere = async (table, filters, values) => {
  if (!filters.length) throw new Error('updateWhere requires at least one filter.')
  const q = applyFilters(db().from(table).update(values), table, filters)
  const { error } = await q
  if (error) throw error
}

const deleteById = async (table, id) => {
  if (isBlank(id)) return

  const { error } = await db().from(table).delete().eq('id', id)
  if (error) throw error
}

// Atomic per-branch ticket sequence (PostgreSQL function allocate_queue_sequence).
const allocateNextSequence = async (branchId) => {
  const { data, error } = await db().rpc('allocate_queue_sequence', { branch_uuid: branchId })
  if (error) throw error
  return data
}

// Bulk delete every row matching the filters. Refuses to run without a filter.
const deleteWhere = async (table, filters) => {
  if (!filters.length) throw new Error('deleteWhere requires at least one filter.')
  const q = applyFilters(db().from(table).delete(), table, filters)
  const { error } = await q
  if (error) throw error
}

module.exports = {
  db,
  findById,
  findMany,
  insert,
  updateById,
  updateWhere,
  deleteById,
  deleteWhere,
  allocateNextSequence,
}
