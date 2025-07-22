import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { parse as json2csv } from 'json2csv';

// Resuelve la ruta al archivo .env para que siempre funcione
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import QueryRunner from './db_runners/QueryRunner.js';

// 1. Configuración de la base de datos (lee de .env o hardcodea aquí)
const db_type = process.env.DB_TYPE ;
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

// Utilidad para comillas según motor
function quoteIdent(ident) {
  return db_type === 'mysql' ? `\`${ident}\`` : `"${ident}"`;
}

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
  'Crea una nueva tabla en la base de datos usando un objeto con nombreTabla y columnas.',
  {
    nombreTabla: z.string().describe('Nombre de la tabla a crear'),
    columnas: z.array(z.object({
      nombre: z.string().describe('Nombre de la columna'),
      tipo: z.string().describe('Tipo y restricciones de la columna (ej. INT PRIMARY KEY AUTO_INCREMENT)'),
    })).describe('Lista de columnas con nombre y tipo'),
  },
  async ({ nombreTabla, columnas }) => {
    try {
      if (!nombreTabla || !Array.isArray(columnas) || columnas.length === 0) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Debes proporcionar un nombre de tabla y al menos una columna.' }]
        };
      }
      try {
        const colsExistentes = await query_runner.getTableColumns(nombreTabla);
        if (colsExistentes && colsExistentes.length > 0) {
          return { content: [{ type: 'text', text: `La tabla '${nombreTabla}' ya existe. No es necesario crearla.` }] };
        }
      } catch (tableCheckError) {}
      const columnasSQL = columnas.map(col => `${quoteIdent(col.nombre)} ${col.tipo}`).join(',\n');
      const sql = `CREATE TABLE ${quoteIdent(nombreTabla)} (\n${columnasSQL}\n)`;
      await query_runner.runQuery(sql);
      return { content: [{ type: 'text', text: 'Tabla creada exitosamente.' }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error al crear la tabla: ' + (e.message || e) }]
      };
    }
  }
);

// --- Herramienta: Agregar columna a tabla ---
server.tool(
  'agregarColumna',
  'Agrega una nueva columna a una tabla existente.',
  {
    tabla: z.string().describe('Nombre de la tabla a modificar'),
    columna: z.string().describe('Nombre de la nueva columna'),
    tipo: z.string().describe('Definición del tipo de la columna (ej. VARCHAR(255) NOT NULL)'),
  },
  async ({ tabla, columna, tipo }) => {
    try {
      if (!/^[a-zA-Z0-9_]+$/.test(tabla) || !/^[a-zA-Z0-9_]+$/.test(columna)) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Nombre de tabla o columna no válido. Use solo letras, números y guiones bajos.' }]
        };
      }
      const query = `ALTER TABLE ${quoteIdent(tabla)} ADD COLUMN ${quoteIdent(columna)} ${tipo}`;
      await query_runner.runQuery(query);
      return { content: [{ type: 'text', text: `Columna '${columna}' agregada a la tabla '${tabla}' exitosamente.` }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error al agregar la columna: ' + (e.message || e) }]
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

// --- Herramienta: Insertar datos en una tabla ---
server.tool(
  'insertarDatos',
  'Inserta datos en una tabla específica.',
  {
    tabla: z.string().describe('Nombre de la tabla'),
    datos: z.array(z.record(z.any())).describe('Array de objetos con los datos a insertar'),
  },
  async ({ tabla, datos }) => {
    try {
      if (!datos || !Array.isArray(datos) || datos.length === 0) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Debes proporcionar un array de datos para insertar.' }]
        };
      }
      let insertedCount = 0;
      for (const registro of datos) {
        const columnas = Object.keys(registro);
        const valores = Object.values(registro);
        const placeholders = valores.map(() => '?').join(', ');
        const columnasStr = columnas.map(col => quoteIdent(col)).join(', ');
        const sql = `INSERT INTO ${quoteIdent(tabla)} (${columnasStr}) VALUES (${placeholders})`;
        await query_runner.runQueryWithParams(sql, valores);
        insertedCount++;
      }
      return { 
        content: [{ 
          type: 'text', 
          text: `Se insertaron ${insertedCount} registro(s) en la tabla '${tabla}' exitosamente.` 
        }] 
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error al insertar datos: ' + (e.message || e) }]
      };
    }
  }
);

// --- Herramienta: CRUD general para tablas ---
server.tool(
  'crudTabla',
  'Permite realizar operaciones CRUD (crear, leer, actualizar, borrar) en cualquier tabla.',
  {
    tabla: z.string().describe('Nombre de la tabla'),
    accion: z.enum(['create', 'read', 'update', 'delete']).describe('Acción CRUD a realizar'),
    datos: z.record(z.any()).optional().describe('Datos para crear o actualizar (objeto)'),
    filtro: z.record(z.any()).optional().describe('Filtro para leer, actualizar o borrar (objeto)'),
  },
  async ({ tabla, accion, datos, filtro }) => {
    try {
      if (!tabla || !accion) {
        return { isError: true, content: [{ type: 'text', text: 'Debes especificar la tabla y la acción.' }] };
      }
      if ((accion === 'create' || accion === 'update') && (!datos || typeof datos !== 'object')) {
        return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar datos para crear o actualizar.' }] };
      }
      if ((accion === 'update' || accion === 'delete' || accion === 'read') && (!filtro || typeof filtro !== 'object')) {
        filtro = {};
      }
      let sql = '';
      let valores = [];
      if (accion === 'create') {
        const columnas = Object.keys(datos);
        const vals = Object.values(datos);
        const placeholders = vals.map(() => '?').join(', ');
        const columnasStr = columnas.map(col => quoteIdent(col)).join(', ');
        sql = `INSERT INTO ${quoteIdent(tabla)} (${columnasStr}) VALUES (${placeholders})`;
        valores = vals;
        await query_runner.runQueryWithParams(sql, valores);
        return { content: [{ type: 'text', text: 'Registro creado exitosamente.' }] };
      } else if (accion === 'read') {
        let where = '';
        if (filtro && Object.keys(filtro).length > 0) {
          const condiciones = Object.keys(filtro).map(col => `${quoteIdent(col)} = ?`);
          where = 'WHERE ' + condiciones.join(' AND ');
          valores = Object.values(filtro);
        }
        sql = `SELECT * FROM ${quoteIdent(tabla)} ${where}`;
        const result = await query_runner.runQueryWithParams(sql, valores);
        return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
      } else if (accion === 'update') {
        if (!filtro || Object.keys(filtro).length === 0) {
          return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar un filtro para actualizar.' }] };
        }
        const setCols = Object.keys(datos).map(col => `${quoteIdent(col)} = ?`).join(', ');
        const setVals = Object.values(datos);
        const whereCols = Object.keys(filtro).map(col => `${quoteIdent(col)} = ?`).join(' AND ');
        const whereVals = Object.values(filtro);
        sql = `UPDATE ${quoteIdent(tabla)} SET ${setCols} WHERE ${whereCols}`;
        valores = [...setVals, ...whereVals];
        const result = await query_runner.runQueryWithParams(sql, valores);
        return { content: [{ type: 'text', text: `Registros actualizados: ${result.rows?.affectedRows ?? 'verifica la tabla.'}` }] };
      } else if (accion === 'delete') {
        if (!filtro || Object.keys(filtro).length === 0) {
          return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar un filtro para borrar.' }] };
        }
        const whereCols = Object.keys(filtro).map(col => `${quoteIdent(col)} = ?`).join(' AND ');
        const whereVals = Object.values(filtro);
        sql = `DELETE FROM ${quoteIdent(tabla)} WHERE ${whereCols}`;
        valores = whereVals;
        const result = await query_runner.runQueryWithParams(sql, valores);
        return { content: [{ type: 'text', text: `Registros eliminados: ${result.rows?.affectedRows ?? 'verifica la tabla.'}` }] };
      }
      return { isError: true, content: [{ type: 'text', text: 'Acción no soportada.' }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error en CRUD: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Eliminar tabla ---
server.tool(
  'eliminarTabla',
  'Elimina una tabla de la base de datos.',
  {
    nombreTabla: z.string().describe('Nombre de la tabla a eliminar'),
  },
  async ({ nombreTabla }) => {
    try {
      if (!nombreTabla) {
        return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar el nombre de la tabla.' }] };
      }
      await query_runner.runQuery(`DROP TABLE IF EXISTS ${quoteIdent(nombreTabla)}`);
      return { content: [{ type: 'text', text: `Tabla '${nombreTabla}' eliminada exitosamente.` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al eliminar la tabla: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Renombrar tabla ---
server.tool(
  'renombrarTabla',
  'Cambia el nombre de una tabla existente.',
  {
    nombreActual: z.string().describe('Nombre actual de la tabla'),
    nuevoNombre: z.string().describe('Nuevo nombre para la tabla'),
  },
  async ({ nombreActual, nuevoNombre }) => {
    try {
      if (!nombreActual || !nuevoNombre) {
        return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar el nombre actual y el nuevo nombre.' }] };
      }
      let sql;
      if (db_type === 'mysql') {
        sql = `ALTER TABLE ${quoteIdent(nombreActual)} RENAME TO ${quoteIdent(nuevoNombre)}`;
      } else {
        sql = `ALTER TABLE ${quoteIdent(nombreActual)} RENAME TO ${quoteIdent(nuevoNombre)}`;
      }
      await query_runner.runQuery(sql);
      return { content: [{ type: 'text', text: `Tabla renombrada de '${nombreActual}' a '${nuevoNombre}' exitosamente.` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al renombrar la tabla: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Renombrar columna ---
server.tool(
  'renombrarColumna',
  'Cambia el nombre de una columna en una tabla.',
  {
    tabla: z.string().describe('Nombre de la tabla'),
    columnaActual: z.string().describe('Nombre actual de la columna'),
    nuevoNombre: z.string().describe('Nuevo nombre para la columna'),
    tipo: z.string().describe('Tipo de la columna (ej. VARCHAR(255) NOT NULL)'),
  },
  async ({ tabla, columnaActual, nuevoNombre, tipo }) => {
    try {
      if (!tabla || !columnaActual || !nuevoNombre || !tipo) {
        return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar la tabla, columna actual, nuevo nombre y tipo.' }] };
      }
      let sql;
      if (db_type === 'mysql') {
        sql = `ALTER TABLE ${quoteIdent(tabla)} CHANGE ${quoteIdent(columnaActual)} ${quoteIdent(nuevoNombre)} ${tipo}`;
      } else {
        sql = `ALTER TABLE ${quoteIdent(tabla)} RENAME COLUMN ${quoteIdent(columnaActual)} TO ${quoteIdent(nuevoNombre)}`;
      }
      await query_runner.runQuery(sql);
      return { content: [{ type: 'text', text: `Columna renombrada de '${columnaActual}' a '${nuevoNombre}' exitosamente.` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al renombrar la columna: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Eliminar columna ---
server.tool(
  'eliminarColumna',
  'Elimina una columna de una tabla.',
  {
    tabla: z.string().describe('Nombre de la tabla'),
    columna: z.string().describe('Nombre de la columna a eliminar'),
  },
  async ({ tabla, columna }) => {
    try {
      if (!tabla || !columna) {
        return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar la tabla y la columna.' }] };
      }
      await query_runner.runQuery(`ALTER TABLE ${quoteIdent(tabla)} DROP COLUMN ${quoteIdent(columna)}`);
      return { content: [{ type: 'text', text: `Columna '${columna}' eliminada de la tabla '${tabla}' exitosamente.` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al eliminar la columna: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Agregar restricción UNIQUE ---
server.tool(
  'agregarRestriccionUnica',
  'Agrega una restricción UNIQUE a una columna o conjunto de columnas.',
  {
    tabla: z.string().describe('Nombre de la tabla'),
    columnas: z.array(z.string()).describe('Columnas a restringir como únicas'),
    nombre: z.string().optional().describe('Nombre de la restricción (opcional)'),
  },
  async ({ tabla, columnas, nombre }) => {
    try {
      if (!tabla || !columnas || columnas.length === 0) {
        return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar la tabla y al menos una columna.' }] };
      }
      const restriccion = nombre ? quoteIdent(nombre) : '';
      const cols = columnas.map(quoteIdent).join(', ');
      const sql = `ALTER TABLE ${quoteIdent(tabla)} ADD CONSTRAINT ${restriccion} UNIQUE (${cols})`;
      await query_runner.runQuery(sql);
      return { content: [{ type: 'text', text: 'Restricción UNIQUE agregada exitosamente.' }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al agregar restricción UNIQUE: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Eliminar restricción UNIQUE ---
server.tool(
  'eliminarRestriccionUnica',
  'Elimina una restricción UNIQUE por nombre.',
  {
    tabla: z.string().describe('Nombre de la tabla'),
    nombre: z.string().describe('Nombre de la restricción UNIQUE'),
  },
  async ({ tabla, nombre }) => {
    try {
      if (!tabla || !nombre) {
        return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar la tabla y el nombre de la restricción.' }] };
      }
      let sql;
      if (db_type === 'mysql') {
        sql = `ALTER TABLE ${quoteIdent(tabla)} DROP INDEX ${quoteIdent(nombre)}`;
      } else {
        sql = `ALTER TABLE ${quoteIdent(tabla)} DROP CONSTRAINT ${quoteIdent(nombre)}`;
      }
      await query_runner.runQuery(sql);
      return { content: [{ type: 'text', text: 'Restricción UNIQUE eliminada exitosamente.' }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al eliminar restricción UNIQUE: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Agregar clave foránea ---
server.tool(
  'agregarClaveForanea',
  'Agrega una clave foránea a una tabla.',
  {
    tabla: z.string().describe('Tabla que tendrá la clave foránea'),
    columnas: z.array(z.string()).describe('Columnas locales'),
    tablaReferencia: z.string().describe('Tabla referenciada'),
    columnasReferencia: z.array(z.string()).describe('Columnas referenciadas'),
    nombre: z.string().optional().describe('Nombre de la clave foránea (opcional)'),
    onDelete: z.string().optional().describe('Acción ON DELETE (ej. CASCADE, SET NULL)'),
    onUpdate: z.string().optional().describe('Acción ON UPDATE (ej. CASCADE, SET NULL)'),
  },
  async ({ tabla, columnas, tablaReferencia, columnasReferencia, nombre, onDelete, onUpdate }) => {
    try {
      if (!tabla || !columnas || !tablaReferencia || !columnasReferencia) {
        return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar tabla, columnas, tablaReferencia y columnasReferencia.' }] };
      }
      const nombreFK = nombre ? `CONSTRAINT ${quoteIdent(nombre)} ` : '';
      const cols = columnas.map(quoteIdent).join(', ');
      const refCols = columnasReferencia.map(quoteIdent).join(', ');
      let sql = `ALTER TABLE ${quoteIdent(tabla)} ADD ${nombreFK}FOREIGN KEY (${cols}) REFERENCES ${quoteIdent(tablaReferencia)} (${refCols})`;
      if (onDelete) sql += ` ON DELETE ${onDelete}`;
      if (onUpdate) sql += ` ON UPDATE ${onUpdate}`;
      await query_runner.runQuery(sql);
      return { content: [{ type: 'text', text: 'Clave foránea agregada exitosamente.' }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al agregar clave foránea: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Eliminar clave foránea ---
server.tool(
  'eliminarClaveForanea',
  'Elimina una clave foránea por nombre.',
  {
    tabla: z.string().describe('Nombre de la tabla'),
    nombre: z.string().describe('Nombre de la clave foránea'),
  },
  async ({ tabla, nombre }) => {
    try {
      if (!tabla || !nombre) {
        return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar la tabla y el nombre de la clave foránea.' }] };
      }
      let sql;
      if (db_type === 'mysql') {
        sql = `ALTER TABLE ${quoteIdent(tabla)} DROP FOREIGN KEY ${quoteIdent(nombre)}`;
      } else {
        sql = `ALTER TABLE ${quoteIdent(tabla)} DROP CONSTRAINT ${quoteIdent(nombre)}`;
      }
      await query_runner.runQuery(sql);
      return { content: [{ type: 'text', text: 'Clave foránea eliminada exitosamente.' }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al eliminar clave foránea: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Cambiar tipo de columna ---
server.tool(
  'cambiarTipoColumna',
  'Cambia el tipo de datos de una columna en una tabla.',
  {
    tabla: z.string().describe('Nombre de la tabla'),
    columna: z.string().describe('Nombre de la columna a modificar'),
    nuevoTipo: z.string().describe('Nuevo tipo de datos (ej. DATE, VARCHAR(255), INT, etc.)'),
  },
  async ({ tabla, columna, nuevoTipo }) => {
    try {
      if (!tabla || !columna || !nuevoTipo) {
        return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar la tabla, columna y el nuevo tipo.' }] };
      }
      let sql;
      if (db_type === 'mysql') {
        sql = `ALTER TABLE ${quoteIdent(tabla)} MODIFY COLUMN ${quoteIdent(columna)} ${nuevoTipo}`;
      } else {
        sql = `ALTER TABLE ${quoteIdent(tabla)} ALTER COLUMN ${quoteIdent(columna)} TYPE ${nuevoTipo}`;
      }
      await query_runner.runQuery(sql);
      return { content: [{ type: 'text', text: `Tipo de columna '${columna}' cambiado a '${nuevoTipo}' exitosamente.` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al cambiar tipo de columna: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Exportar tabla (CSV o JSON, columnas específicas) ---
server.tool(
  'exportarTabla',
  'Exporta los datos de una tabla o columnas específicas a CSV o JSON.',
  {
    tabla: z.string().describe('Nombre de la tabla a exportar'),
    formato: z.enum(['csv', 'json']).describe('Formato de exportación'),
    columnas: z.array(z.string()).optional().describe('Columnas a exportar (opcional)'),
  },
  async ({ tabla, formato, columnas }) => {
    try {
      let sql = 'SELECT ';
      if (columnas && columnas.length > 0) {
        sql += columnas.map(quoteIdent).join(', ');
      } else {
        sql += '*';
      }
      sql += ` FROM ${quoteIdent(tabla)}`;
      const result = await query_runner.runQuery(sql);
      if (formato === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
      } else {
        // CSV
        const csv = json2csv(result.rows);
        return { content: [{ type: 'text', text: csv }] };
      }
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al exportar tabla: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Importar tabla (CSV o JSON, columnas específicas) ---
server.tool(
  'importarTabla',
  'Importa datos a una tabla desde CSV o JSON. Puedes especificar columnas.',
  {
    tabla: z.string().describe('Nombre de la tabla destino'),
    datos: z.string().describe('Datos a importar (CSV o JSON)'),
    formato: z.enum(['csv', 'json']).describe('Formato de los datos'),
    columnas: z.array(z.string()).optional().describe('Columnas a importar (opcional, para CSV)'),
  },
  async ({ tabla, datos, formato, columnas }) => {
    try {
      let registros = [];
      if (formato === 'json') {
        registros = JSON.parse(datos);
      } else {
        // CSV
        const rows = datos.split(/\r?\n/).filter(Boolean);
        let headers = rows[0].split(',');
        if (columnas && columnas.length > 0) {
          headers = columnas;
        }
        registros = rows.slice(1).map(row => {
          const values = row.split(',');
          const obj = {};
          headers.forEach((h, i) => { obj[h.trim()] = values[i]?.trim(); });
          return obj;
        });
      }
      let insertedCount = 0;
      for (const registro of registros) {
        const cols = columnas && columnas.length > 0 ? columnas : Object.keys(registro);
        const valores = cols.map(c => registro[c]);
        const placeholders = valores.map(() => '?').join(', ');
        const columnasStr = cols.map(col => quoteIdent(col)).join(', ');
        const sql = `INSERT INTO ${quoteIdent(tabla)} (${columnasStr}) VALUES (${placeholders})`;
        await query_runner.runQueryWithParams(sql, valores);
        insertedCount++;
      }
      return { content: [{ type: 'text', text: `Se importaron ${insertedCount} registro(s) en la tabla '${tabla}' exitosamente.` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al importar datos: ' + (e.message || e) }] };
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
