const { initSupabase } = require('./supabase')

const connectDB = async () => {
  const client = initSupabase()
  if (!client) return false

  console.log('Supabase initialized')
  return true
}

module.exports = connectDB
