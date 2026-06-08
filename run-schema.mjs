import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new Client({
  connectionString: 'postgresql://postgres:enova8757%21%21@db.gvpaprczqxdhldotoxqk.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false },
});

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

await client.connect();
console.log('Connected to Supabase PostgreSQL');

try {
  await client.query(sql);
  console.log('schema.sql executed successfully');
} catch (e) {
  console.error('Error:', e.message);
} finally {
  await client.end();
}
