import mysql from 'mysql2/promise';
import pg from 'pg';

const { Pool } = pg;

/**
 * QueryRunner: universal para MySQL y PostgreSQL usando pools de conexiones.
 */
export default class QueryRunner {
  constructor(db_type, configuration) {
    this.db_type = db_type;
    this.config = configuration;
    this.pool = null;

    if (this.db_type === 'mysql') {
      this.pool = mysql.createPool(this.config);
    } else if (this.db_type === 'pg' || this.db_type === 'postgresql') {
      this.pool = new Pool(this.config);
    } else {
      throw new Error('Tipo de base de datos no soportado: ' + this.db_type);
    }
  }

  async testConnection() {
    if (this.db_type === 'mysql') {
      const conn = await this.pool.getConnection();
      await conn.ping();
      conn.release();
    } else {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
    }
  }

  async runQuery(sql) {
    if (this.db_type === 'mysql') {
      const [rows, fields] = await this.pool.execute(sql);
      return {
        columns: fields ? fields.map(f => ({ name: f.name })) : [],
        rows: Array.isArray(rows) ? rows : []
      };
    } else { // pg
      const res = await this.pool.query(sql);
      return {
        columns: res.fields ? res.fields.map(f => ({ name: f.name })) : [],
        rows: res.rows || []
      };
    }
  }

  async runQueryWithParams(sql, params) {
    if (this.db_type === 'mysql') {
      const [rows, fields] = await this.pool.execute(sql, params);
      return {
        columns: fields ? fields.map(f => ({ name: f.name })) : [],
        rows: rows
      };
    } else { // pg
      const res = await this.pool.query(sql, params);
      return {
        columns: res.fields ? res.fields.map(f => ({ name: f.name })) : [],
        rows: res.rows
      };
    }
  }

  async getSchema() {
    if (this.db_type === 'mysql') {
      const [tables] = await this.pool.execute("SHOW TABLES");
      const tableKey = Object.keys(tables[0])[0];
      return await Promise.all(tables.map(async tbl => {
        const tableName = tbl[tableKey];
        const [cols] = await this.pool.execute(`SHOW COLUMNS FROM \`${tableName}\``);
        return {
          name: tableName,
          columns: cols.map(c => ({ name: c.Field, type: c.Type }))
        };
      }));
    } else { // pg
      const res = await this.pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type='BASE TABLE'
      `);
      return await Promise.all(res.rows.map(async row => {
        const tname = row.table_name;
        const res2 = await this.pool.query(`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_name = $1
        `, [tname]);
        return {
          name: tname,
          columns: res2.rows.map(c => ({ name: c.column_name, type: c.data_type }))
        };
      }));
    }
  }

  async getTableColumns(table) {
    try {
      if (this.db_type === 'mysql') {
        const [cols] = await this.pool.execute(`SHOW COLUMNS FROM \`${table}\``);
        return cols.map(c => c.Field);
      } else { // pg
        const res = await this.pool.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = $1
        `, [table]);
        return res.rows.map(c => c.column_name);
      }
    } catch (error) {
      // Si la tabla no existe, retornamos un array vacío
      return [];
    }
  }

  async closePool() {
    if (this.pool) {
      await this.pool.end();
    }
  }
}
