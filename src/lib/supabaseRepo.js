const { getSupabase } = require('../config/supabase')

const db = () => {
  const client = getSupabase()
  if (!client) throw new Error('Supabase client is not initialized.')
  return client
}

const queryOne = async (table, queryBuilder) => {
  const { data, error } = await queryBuilder.single()
  if (error) throw error
  return data
}

const findById = async (table, id, columns = '*') => {
  const { data, error } = await db().from(table).select(columns).eq('id', id).single()
  if (error) return null
  return data
}

const findMany = async (table, { select = '*', filters = [], order = null, limit = null, range = null } = {}) => {
  let q = db().from(table).select(select)
  filters.forEach(([col, op, value]) => {
    if (op === 'eq') q = q.eq(col, value)
    if (op === 'in') q = q.in(col, value)
    if (op === 'neq') q = q.neq(col, value)
    if (op === 'ilike') q = q.ilike(col, value)
    if (op === 'gte') q = q.gte(col, value)
    if (op === 'lte') q = q.lte(col, value)
  })
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
  const { data, error } = await db().from(table).update(values).eq('id', id).select(select)
  if (error) throw error
  return Array.isArray(data) ? data[0] : data
}

const deleteById = async (table, id) => {
  const { error } = await db().from(table).delete().eq('id', id)
  if (error) throw error
}

module.exports = {
  db,
  queryOne,
  findById,
  findMany,
  insert,
  updateById,
  deleteById,
}
