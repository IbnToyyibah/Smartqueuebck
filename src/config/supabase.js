const { createClient } = require('@supabase/supabase-js')

let supabaseClient = null

const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY']

const initSupabase = () => {
  const missing = requiredEnv.filter((key) => !process.env[key])
  if (missing.length > 0) {
    console.error(`Missing Supabase env vars: ${missing.join(', ')}`)
    return null
  }

  if (supabaseClient) return supabaseClient

  supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  console.log('[supabase] client initialized')
  return supabaseClient
}

const getSupabase = () => supabaseClient || initSupabase()

module.exports = {
  initSupabase,
  getSupabase,
}
