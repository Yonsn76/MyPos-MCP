import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Resuelve la ruta al archivo .env para que siempre funcione
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import QueryRunner from './db_runners/QueryRunner.js';

// 1. Configuración de la base de datos (lee de .env o hardcodea aquí)
const db_type = process.env.DB_TYPE || 'mysql';
const db_port = process.env.DB_PORT ? parseInt(process.env.DB_PORT) : undefined;

if (!db_port) {
  throw new Error("Debes definir el puerto de la base de datos con la variable DB_PORT (ej. 3306 para MySQL)");
}

const db_config = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER ,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: db_port, // <-- Requerido
};

const db_id = `${db_type.toLowerCase()}_default`;
const query_runner = new QueryRunner(db_type, db_config);

// 2. Crear el servidor MCP y registrar las herramientas
const server = new McpServer({
  transport_logging: false, // Silencia el log de MCP para ver mejor los nuestros
  name: 'MyBase',
  version: '1.0.0',
});

// --- Herramienta: Listar tablas ---
server.tool(
  'listarTablas',
  'Lista todas las tablas de la base de datos.',
  {},
  async () => {
    const schema = await query_runner.getSchema();
    return {
      content: [
        { type: 'text', text: 'Tablas:\n' + schema.map(t => `- ${t.name}`).join('\n') }
      ]
    };
  }
);

// --- Herramienta: Ejecutar consulta SQL SELECT ---
server.tool(
  'consultarSQL',
  'Ejecuta una consulta SQL SELECT y devuelve los resultados como tabla.',
  {
    consulta: z.string().describe('Consulta SQL tipo SELECT'),
  },
  async ({ consulta }) => {
    try {
      // Solo se permiten SELECT
      if (!/^select/i.test(consulta.trim())) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Solo se permiten consultas SELECT.' }]
        };
      }
      const result = await query_runner.runQuery(consulta);
      const rows = result.rows;
      if (!rows.length) {
        return { content: [{ type: 'text', text: 'Sin resultados.' }] };
      }
      const headers = result.columns.map(c => c.name).join(' | ');
      const dataRows = rows.map(row => result.columns.map(c => String(row[c.name])).join(' | ')).join('\n');
      return {
        content: [
          { type: 'text', text: `${headers}\n${'-'.repeat(headers.length)}\n${dataRows}` }
        ]
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error al consultar: ' + (e.message || e) }]
      };
    }
  }
);

// --- Herramienta: Crear tabla --- 
server.tool(
  'crearTabla',
  'Crea una nueva tabla en la base de datos.',
  {
    definicion: z.string().describe('Sentencia SQL CREATE TABLE completa. Ejemplo: CREATE TABLE personas (id INT, nombre VARCHAR(255))'),
  },
  async ({ definicion }) => {
    try {
      // Solo se permiten CREATE TABLE
      if (!/^create table/i.test(definicion.trim())) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Solo se permiten sentencias CREATE TABLE.' }]
        };
      }
      await query_runner.runQuery(definicion);
      return { content: [{ type: 'text', text: 'Tabla creada exitosamente.' }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error al crear la tabla: ' + (e.message || e) }]
      };
    }
  }
);

// --- Herramienta: Listar columnas de una tabla ---
server.tool(
  'columnasDeTabla',
  'Devuelve los nombres de columnas para una tabla específica.',
  {
    tabla: z.string().describe('Nombre de la tabla')
  },
  async ({ tabla }) => {
    try {
      const cols = await query_runner.getTableColumns(tabla);
      return { content: [{ type: 'text', text: cols.join(', ') }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error: ' + (e.message || e) }] };
    }
  }
);

// 3. Transport por stdio para adapters MCP/AI
const transport = new StdioServerTransport();
server.connect(transport).then(async () => {
  try {
    console.log('Probando conexión a la base de datos...');
    await query_runner.testConnection();
    console.log('Conexión a la base de datos exitosa.');
  } catch (e) {
    console.error('Error al conectar con la base de datos:', e.message);
    // Opcional: salir si la conexión falla al inicio
    // process.exit(1);
  }
});

// Cierre
const cleanup = async () => {
  console.log('Cerrando servidor y pool de conexiones...');
  await server.close();
  await query_runner.closePool();
  process.exit(0);
};

process.on('SIGINT', cleanup); // Ctrl+C
process.on('SIGTERM', cleanup); // Terminación

console.log('Servidor MyBase MCP corriendo por stdio');
