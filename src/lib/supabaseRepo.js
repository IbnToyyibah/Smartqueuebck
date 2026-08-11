const { getSupabase } = require("../config/supabase");
const db = () => {
  const client = getSupabase();
  if (!client) throw new Error("Supabase not initialized");
  return client;
};

const isBlank = (v) =>
  v === "" ||
  v === null ||
  v === undefined;

const queryOne = async (table, queryBuilder) => {
  const { data, error } =
    await queryBuilder.single();

  if (error) throw error;
  return data;
};

const findById = async (
  table,
  id,
  columns = "*"
) => {
  if (isBlank(id)) return null;

  const { data, error } = await db()
    .from(table)
    .select(columns)
    .eq("id", id)
    .single();

  if (error) return null;

  return data;
};

const findMany = async (
  table,
  {
    select = "*",
    filters = [],
    order = null,
    limit = null,
    range = null,
  } = {}
) => {
  let q = db().from(table).select(select);

  filters.forEach(([col, op, value]) => {
    if (isBlank(value)) return;

    switch (op) {
      case "eq":
        q = q.eq(col, value);
        break;

      case "neq":
        q = q.neq(col, value);
        break;

      case "in":
        q = q.in(col, value);
        break;

      case "ilike":
        q = q.ilike(col, value);
        break;

      case "gte":
        q = q.gte(col, value);
        break;

      case "lte":
        q = q.lte(col, value);
        break;
    }
  });

  if (order)
    q = q.order(order.column, {
      ascending: order.ascending ?? true,
    });

  if (range)
    q = q.range(range.from, range.to);

  if (limit)
    q = q.limit(limit);

  const { data, error } = await q;

  if (error) throw error;

  return data || [];
};

const insert = async (
  table,
  values,
  select = "*"
) => {
  const { data, error } = await db()
    .from(table)
    .insert(values)
    .select(select);

  if (error) throw error;

  return Array.isArray(data)
    ? data[0]
    : data;
};

const updateById = async (
  table,
  id,
  values,
  select = "*"
) => {
  if (isBlank(id)) return null;

  const { data, error } = await db()
    .from(table)
    .update(values)
    .eq("id", id)
    .select(select);

  if (error) throw error;

  return Array.isArray(data)
    ? data[0]
    : data;
};

const deleteById = async (
  table,
  id
) => {
  if (isBlank(id)) return;

  const { error } = await db()
    .from(table)
    .delete()
    .eq("id", id);

  if (error) throw error;
};

/*
 NEW FUNCTION
 Calls PostgreSQL atomic function
*/

const allocateNextSequence = async (
  branchId
) => {
  const { data, error } =
    await db().rpc(
      "allocate_queue_sequence",
      {
        branch_uuid: branchId,
      }
    );

  if (error) throw error;

  return data;
};

module.exports = {
  db,
  queryOne,
  findById,
  findMany,
  insert,
  updateById,
  deleteById,
  allocateNextSequence,
};