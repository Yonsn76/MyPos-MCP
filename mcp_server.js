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
// Elimino la importación de PROMPTS
// import PROMPTS from './prompts.js';

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

// Utilidad para placeholders según motor
function makePlaceholders(db_type, count, offset = 0) {
  if (db_type === 'mysql') {
    return Array(count).fill('?');
  } else {
    // PostgreSQL: $1, $2, ... (offset para casos como update)
    return Array.from({ length: count }, (_, i) => `$${i + 1 + offset}`);
  }
}

// 2. Crear el servidor MCP y registrar las herramientas
const server = new McpServer({
  transport_logging: false, // Silencia el log de MCP para ver mejor los nuestros
  name: 'MyBase',
  version: '1.0.0',
});

// =================================================================
// --- I. HERRAMIENTAS DE CONSULTA (LEER DATOS) ---
// =================================================================
// --- Herramienta: Listar tablas ---
server.tool(
  'listarTablas',
  'Sigue estas reglas para listar tablas:\n'
  + 'PROPÓSITO: Obtener una lista de todas las tablas en la base de datos.\n'
  + 'USO: Úsalo cuando necesites saber qué tablas existen.\n'
  + 'EJEMPLO: "Muestra las tablas disponibles."',
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

// --- Herramienta: Listar columnas de una tabla ---
server.tool(
  'columnasDeTabla',
  'Sigue estas reglas para listar columnas:\n'
  + 'PROPÓSITO: Obtener una lista con los nombres de todas las columnas de una tabla específica.\n'
  + 'USO: Útil para conocer la estructura de una tabla antes de realizar una consulta o inserción.\n'
  + 'EJEMPLO: "¿Cuáles son las columnas de la tabla ventas?"',
  {
    tabla: z.string().describe('Nombre de la tabla'),
  },
  async ({ tabla }) => {
    try {
      const columns = await query_runner.getTableColumns(tabla);
      if (!columns || columns.length === 0) {
        return { content: [{ type: 'text', text: `La tabla '${tabla}' no tiene columnas.` }] };
      }
      return {
        content: [
          { type: 'text', text: `Columnas de la tabla '${tabla}':\n` + columns.map(col => `- ${col}`).join('\n') }
        ]
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: 'Error al listar columnas: ' + (e.message || e) }] };
    }
  }
);

// --- Herramienta: Ejecutar consulta SQL SELECT ---
server.tool(
  'consultarSQL',
  'Sigue estas reglas para consultar con SQL:\n'
  + 'PROPÓSITO: Ejecutar una consulta SQL de solo lectura (SELECT) para obtener datos.\n'
  + 'RESTRICCIÓN DE SEGURIDAD: Solo se permiten consultas que comiencen con SELECT. Cualquier otro tipo de consulta (INSERT, UPDATE, DELETE, DROP) será rechazado.\n'
  + 'USO: Ideal para obtener datos específicos, filtrar o unir tablas.\n'
  + 'EJEMPLO: "Muestra todos los clientes registrados."',
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

// --- Herramienta: Exportar tabla (CSV o JSON, columnas específicas) ---
server.tool(
  'exportarTabla',
  'Sigue estas reglas para exportar una tabla:\n'
  + 'PROPÓSITO: Exportar los datos de una tabla a un formato de texto (CSV o JSON).\n'
  + 'USO: Especifica la tabla y el formato deseado. Opcionalmente, puedes indicar columnas específicas para exportar solo una parte de los datos.\n'
  + 'EJEMPLO: "Exporta la tabla clientes a CSV."',
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
  'Sigue estas reglas para importar a una tabla:\n'
  + 'PROPÓSITO: Importar y insertar datos en una tabla desde un formato de texto (CSV o JSON).\n'
  + 'PRECAUCIÓN: Asegúrate de que los datos en el texto coincidan con las columnas y tipos de la tabla destino para evitar errores.\n'
  + 'USO: Proporciona el nombre de la tabla, los datos en formato de texto (string) y el formato (csv o json).\n'
  + 'EJEMPLO: "Importa los datos del archivo clientes.csv a la tabla clientes."',
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
        const placeholders = makePlaceholders(db_type, valores.length).join(', ');
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

// =================================================================
// --- II. HERRAMIENTAS DE CREACIÓN (AÑADIR DATOS O ESTRUCTURA) ---
// =================================================================
// --- Herramienta: Crear tabla ---
server.tool(
  'crearTabla',
  'Sigue estas reglas para crear una tabla:\n'
  + 'PROPÓSITO: Crear una tabla COMPLETAMENTE NUEVA en la base de datos.\n'
  + 'REGLA: No uses esta herramienta para modificar o agregar columnas a una tabla que ya existe. La herramienta fallará si la tabla ya existe.\n'
  + 'USO: Define el nombre de la tabla y la estructura de sus columnas.\n'
  + 'EJEMPLO: "Crea la tabla productos con columnas id y nombre."',
  {
    nombreTabla: z.string().describe('Nombre de la nueva tabla'),
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
  'Sigue estas reglas para agregar una columna:\n'
  + 'PROPÓSITO: Agregar una nueva columna a una tabla EXISTENTE.\n'
  + 'REGLA: No la uses para crear tablas nuevas ni para modificar o eliminar columnas existentes.\n'
  + 'PRECAUCIÓN: Asegúrate de que el nombre de la tabla y la nueva columna sean correctos antes de ejecutar.\n'
  + 'EJEMPLO: "Agrega la columna email a la tabla usuarios."',
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

// --- Herramienta: Insertar datos en una tabla ---
server.tool(
  'insertarDatos',
  'Sigue estas reglas para insertar datos:\n'
  + 'PROPÓSITO: Insertar uno o varios registros (filas) nuevos en una tabla.\n'
  + 'REGLA: Solo debe usarse para agregar datos nuevos. No la uses para actualizar registros existentes ni para modificar la estructura de la tabla.\n'
  + 'FORMATO: Los datos deben ser un array de objetos, donde cada objeto es un registro.\n'
  + 'EJEMPLO: "Agrega un cliente con nombre Juan a la tabla clientes."',
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
        const placeholders = makePlaceholders(db_type, valores.length).join(', ');
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
  'Sigue estas reglas OBLIGATORIAS para operaciones CRUD:\n'
  + 'PROPÓSITO: Realizar operaciones de Crear (create), Leer (read), Actualizar (update) o Eliminar (delete) registros en una tabla.\n'
  + 'REGLA: Esta herramienta es solo para MANIPULAR DATOS, nunca para modificar la ESTRUCTURA de la tabla (ALTER, DROP, CREATE TABLE).\n'
  + 'ACCIÓN DESTRUCTIVA (DELETE): Si la acción es "delete", es OBLIGATORIO pedir una confirmación explícita al usuario antes de ejecutar. El usuario DEBE escribir la frase exacta: "Confirmar eliminación de los registros filtrados en la tabla [nombreTabla]". Si la confirmación no es exacta, no procedas.\n'
  + 'USO: Especifica la tabla, la acción, los datos (para create/update) y el filtro (para read/update/delete).\n'
  + 'EJEMPLO: "Actualiza el email del cliente con id 5 en la tabla clientes."',
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
        const placeholders = makePlaceholders(db_type, vals.length).join(', ');
        const columnasStr = columnas.map(col => quoteIdent(col)).join(', ');
        sql = `INSERT INTO ${quoteIdent(tabla)} (${columnasStr}) VALUES (${placeholders})`;
        valores = vals;
        await query_runner.runQueryWithParams(sql, valores);
        return { content: [{ type: 'text', text: 'Registro creado exitosamente.' }] };
      } else if (accion === 'read') {
        let where = '';
        if (filtro && Object.keys(filtro).length > 0) {
          const condiciones = Object.keys(filtro).map((col, i) => `${quoteIdent(col)} = ${makePlaceholders(db_type, 1, i)[0]}`);
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
        const setCols = Object.keys(datos).map((col, i) => `${quoteIdent(col)} = ${makePlaceholders(db_type, 1, i)[0]}`).join(', ');
        const setVals = Object.values(datos);
        const whereCols = Object.keys(filtro).map((col, i) => `${quoteIdent(col)} = ${makePlaceholders(db_type, 1, setVals.length + i)[0]}`).join(' AND ');
        const whereVals = Object.values(filtro);
        sql = `UPDATE ${quoteIdent(tabla)} SET ${setCols} WHERE ${whereCols}`;
        valores = [...setVals, ...whereVals];
        const result = await query_runner.runQueryWithParams(sql, valores);
        return { content: [{ type: 'text', text: `Registros actualizados: ${result.rows?.affectedRows ?? 'verifica la tabla.'}` }] };
      } else if (accion === 'delete') {
        if (!filtro || Object.keys(filtro).length === 0) {
          return { isError: true, content: [{ type: 'text', text: 'Debes proporcionar un filtro para borrar.' }] };
        }
        const whereCols = Object.keys(filtro).map((col, i) => `${quoteIdent(col)} = ${makePlaceholders(db_type, 1, i)[0]}`).join(' AND ');
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

// =================================================================
// --- III. HERRAMIENTAS DE ACTUALIZACIÓN (MODIFICAR DATOS O ESTRUCTURA) ---
// =================================================================
// --- Herramienta: Renombrar tabla ---
server.tool(
  'renombrarTabla',
  'Sigue estas reglas OBLIGATORIAS para renombrar una tabla:\n'
  + 'ADVERTENCIA: Renombrar una tabla es una acción delicada que puede romper consultas o vistas existentes que dependan de ella. Procede con cuidado.\n'
  + 'PROPÓSITO: Cambiar el nombre de una tabla existente por uno nuevo.\n'
  + 'VERIFICACIÓN: Asegúrate de que el nuevo nombre no esté ya en uso.\n'
  + 'USO: Proporciona el nombre actual y el nuevo nombre.\n'
  + 'EJEMPLO: "Renombra la tabla ventas a ventas_2024."',
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
  'Sigue estas reglas OBLIGATORIAS para renombrar una columna:\n'
  + 'ADVERTENCIA: Renombrar una columna es una acción delicada que puede romper consultas o código de aplicación que dependan de ella. Procede con cuidado.\n'
  + 'PROPÓSITO: Cambiar el nombre de una columna existente dentro de una tabla.\n'
  + 'REQUISITO: Debes proporcionar el tipo de dato de la columna junto con el nuevo nombre.\n'
  + 'USO: Especifica la tabla, el nombre actual, el nuevo nombre y el tipo de dato.\n'
  + 'EJEMPLO: "Renombra la columna nombre a nombre_completo en la tabla empleados."',
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

// --- Herramienta: Cambiar tipo de columna ---
server.tool(
  'cambiarTipoColumna',
  'Sigue estas reglas OBLIGATORIAS para cambiar el tipo de una columna:\n'
  + 'ADVERTENCIA INICIAL: Informa al usuario que cambiar el tipo de dato de una columna es una acción PELIGROSA que puede resultar en PÉRDIDA DE DATOS si la conversión no es compatible.\n'
  + 'CONFIRMACIÓN EXPLÍCITA: Para proceder, el usuario DEBE escribir la frase exacta: "Confirmar cambio de tipo para la columna [nombreColumna] a [nuevoTipo]".\n'
  + 'VERIFICACIÓN ESTRICTA: No ejecutes la modificación si la confirmación no es exacta.\n'
  + 'USO: Especifica la tabla, la columna y el nuevo tipo de dato.\n'
  + 'EJEMPLO: "Cambia el tipo de la columna fecha a DATE en la tabla ventas."',
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

// =================================================================
// --- IV. HERRAMIENTAS DE ELIMINACIÓN (BORRAR DATOS O ESTRUCTURA) ---
// =================================================================
// --- Herramienta: Eliminar tabla ---
server.tool(
  'eliminarTabla',
  'Sigue estas reglas OBLIGATORIAS para eliminar una tabla:\n'
  + 'ADVERTENCIA INICIAL: Informa al usuario que esta es una acción DESTRUCTIVA y PERMANENTE que no se puede deshacer.\n'
  + 'CONFIRMACIÓN EXPLÍCITA: Para proceder, el usuario DEBE escribir la frase exacta: "Confirmar eliminación de la tabla [nombreTabla]", reemplazando [nombreTabla] con el nombre de la tabla a eliminar.\n'
  + 'VERIFICACIÓN ESTRICTA: No ejecutes la eliminación si la frase de confirmación del usuario no es una coincidencia exacta.\n'
  + 'USO EXCLUSIVO: Recuerda que esta herramienta solo elimina tablas completas, NUNCA registros o columnas individuales.',
  {
    nombreTabla: z.string().describe('Nombre exacto de la tabla que se va a eliminar'),
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

// --- Herramienta: Eliminar columna ---
server.tool(
  'eliminarColumna',
  'Sigue estas reglas OBLIGATORIAS para eliminar una columna:\n'
  + 'ADVERTENCIA INICIAL: Informa al usuario que eliminar una columna es una acción DESTRUCTIVA y PERMANENTE que borrará todos los datos que contiene.\n'
  + 'CONFIRMACIÓN EXPLÍCITA: Para proceder, el usuario DEBE escribir la frase exacta: "Confirmar eliminación de la columna [nombreColumna] de la tabla [nombreTabla]".\n'
  + 'VERIFICACIÓN ESTRICTA: No ejecutes la eliminación si la frase de confirmación no es una coincidencia exacta.\n'
  + 'USO EXCLUSIVO: Úsala solo para eliminar columnas, no tablas ni registros.\n'
  + 'EJEMPLO: "Elimina la columna edad de la tabla clientes."',
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

// --- Herramienta: Eliminar restricción UNIQUE ---
server.tool(
  'eliminarRestriccionUnica',
  'Sigue estas reglas OBLIGATORIAS para eliminar una restricción UNIQUE:\n'
  + 'ADVERTENCIA INICIAL: Informa al usuario que eliminar esta restricción permitirá datos duplicados, lo que podría afectar la integridad de los datos.\n'
  + 'CONFIRMACIÓN EXPLÍCITA: Para proceder, el usuario DEBE escribir la frase exacta: "Confirmar eliminación de la restricción [nombreRestriccion] de la tabla [nombreTabla]".\n'
  + 'VERIFICACIÓN ESTRICTA: No ejecutes la eliminación si la confirmación no es exacta.\n'
  + 'USO: Especifica la tabla y el nombre exacto de la restricción a eliminar.\n'
  + 'EJEMPLO: "Elimina la restricción única email_unique de la tabla usuarios."',
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

// --- Herramienta: Eliminar clave foránea ---
server.tool(
  'eliminarClaveForanea',
  'Sigue estas reglas OBLIGATORIAS para eliminar una clave foránea:\n'
  + 'ADVERTENCIA INICIAL: Informa al usuario que eliminar una clave foránea puede llevar a datos huérfanos y romper la integridad referencial.\n'
  + 'CONFIRMACIÓN EXPLÍCITA: Para proceder, el usuario DEBE escribir la frase exacta: "Confirmar eliminación de la clave foránea [nombreFK] de la tabla [nombreTabla]".\n'
  + 'VERIFICACIÓN ESTRICTA: No ejecutes la eliminación si la confirmación no es exacta.\n'
  + 'USO: Especifica la tabla y el nombre de la clave foránea a eliminar.\n'
  + 'EJEMPLO: "Elimina la clave foránea fk_cliente de la tabla ventas."',
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

// --- Herramienta: Agregar restricción UNIQUE ---
server.tool(
  'agregarRestriccionUnica',
  'Sigue estas reglas para agregar una restricción UNIQUE:\n'
  + 'PROPÓSITO: Agregar una restricción de unicidad (UNIQUE) a una o más columnas para evitar valores duplicados.\n'
  + 'REGLA: No la uses para crear tablas o columnas. La columna ya debe existir.\n'
  + 'PRECAUCIÓN: La operación fallará si ya existen datos duplicados en la(s) columna(s) seleccionada(s).\n'
  + 'USO: Especifica la tabla y las columnas que deben ser únicas.\n'
  + 'EJEMPLO: "Haz que el campo email sea único en la tabla usuarios."',
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

// --- Herramienta: Agregar clave foránea ---
server.tool(
  'agregarClaveForanea',
  'Sigue estas reglas para agregar una clave foránea:\n'
  + 'PROPÓSITO: Crear una relación (clave foránea) entre dos tablas para mantener la integridad referencial.\n'
  + 'REGLA: Las tablas y columnas involucradas ya deben existir.\n'
  + 'PRECAUCIÓN: La operación puede fallar si los datos existentes violan la nueva restricción.\n'
  + 'USO: Especifica la tabla local, sus columnas, la tabla de referencia y sus columnas.\n'
  + 'EJEMPLO: "Agrega una clave foránea de cliente_id en ventas referenciando clientes(id)."',
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
