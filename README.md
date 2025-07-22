# MyPos MCP Project

Este es un proyecto de ejemplo para un **Model-Context-Protocol (MCP)** Server que se conecta a una base de datos.

## Características

- Se conecta a bases de datos MySQL o PostgreSQL.
- Proporciona herramientas para interactuar con la base de datos:
  - `listarTablas`: Enumera todas las tablas en la base de datos.
  - `consultarSQL`: Ejecuta una consulta `SELECT` en la base de datos.
  - `columnasDeTabla`: Enumera las columnas de una tabla específica.

## Requisitos

- Node.js (v16 o superior)
- Una base de datos MySQL o PostgreSQL en ejecución.

## Configuración

1.  **Clonar el repositorio:**

    ```bash
    git clone https://github.com/Yonsn76/MyPos-MCP.git
    cd MyPos-MCP
    ```

2.  **Instalar dependencias:**

    ```bash
    npm install
    ```

3.  **Configurar las variables de entorno:**

    Crea un archivo `.env` en la raíz del proyecto y añade las siguientes variables:

    ```env
    DB_TYPE=mysql # o postgres
    DB_HOST=localhost
    DB_PORT=3306 # o 5432 para postgres
    DB_USER=root
    DB_PASSWORD=tu_contraseña
    DB_DATABASE=nombre_de_la_base_de_datos
    ```

## Uso

Para iniciar el servidor MCP, ejecuta:

```bash
npm start
```

El servidor se iniciará y se conectará a la base de datos especificada en el archivo `.env`.

## Ejemplo de Configuración MCP

Para usar este MCP, puedes agregarlo a tu configuración con el siguiente objeto:

```json
"MyPost MCP": { 
       "type": "stdio", 
       "command": "npx", 
       "args": [ 
         "-y", 
         "node", 
         "C:/Users/Pociko/Desktop/MCP/legion-mcp/Mi-mcp/mcp_server.js"
         //Aqui va la url del directorio en la cual esta el archivo mcp_server.js
       ] 
     }
```