// ============================================
// BACKEND EXPRESS — Demo Importación
// ============================================

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// CONFIGURACIÓN
// ============================================

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Multer (subida de archivos)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes JPG/PNG o PDF'));
    }
  }
});

// Conexión a PostgreSQL (para KPIs y seguimiento)
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'importacion_db',
  client_encoding: 'UTF8'
});

pool.on('connect', client => {
  client.query("SET client_encoding = 'UTF8'");
});

// Almacén en memoria (para demo)
const solicitudes = [];
let contador = 1000;

// ============================================
// UTILIDADES
// ============================================

function archivoABase64(ruta) {
  const bitmap = fs.readFileSync(ruta);
  return `data:image/jpeg;base64,${bitmap.toString('base64')}`;
}

// ============================================
// RUTAS
// ============================================

// --- Health check ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Subir documentación de importación ---
app.post('/api/importacion/upload', upload.single('documento'), async (req, res) => {
  try {
    const {
      nombre_cliente,
      rfc_cliente,
      monto_facturado,
      moneda,
      numero_factura,
      numero_pedido
    } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Falta el documento' });
    }

    const folio = `IMP-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    const solicitud = {
      id: contador++,
      folio,
      nombre_cliente,
      rfc_cliente,
      monto_facturado: parseFloat(monto_facturado) || 0,
      moneda: moneda || 'MXN',
      numero_factura,
      numero_pedido,
      status: 'recibido',
      resultado: null,
      motivo_rechazo: null,
      fecha: new Date().toISOString(),
      archivo: req.file
    };

    solicitudes.push(solicitud);

    // Payload para n8n
    const datosN8N = {
      solicitud_id: solicitud.id,
      folio: solicitud.folio,
      nombre_cliente: solicitud.nombre_cliente,
      rfc_cliente: solicitud.rfc_cliente,
      monto_facturado: solicitud.monto_facturado,
      moneda: solicitud.moneda,
      numero_factura: solicitud.numero_factura,
      numero_pedido: solicitud.numero_pedido,
      archivo: archivoABase64(req.file.path),
      extension: req.file.originalname.split('.').pop()
    };

    console.log('📤 Enviando a n8n...');

    try {
      const respuesta = await fetch(`${process.env.N8N_URL || 'http://localhost:5678'}/webhook/importacion-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(datosN8N)
      });

      const resultado = await respuesta.json();
      console.log('✅ Respuesta de n8n:', resultado);

      if (resultado.resultado) {
        solicitud.resultado = resultado.resultado;
        solicitud.status = resultado.resultado;
        solicitud.motivo_rechazo = resultado.motivo_rechazo || null;

        // Guardar en BD
        try {
          await pool.query(
            `INSERT INTO resultados_importacion (folio, resultado, motivo_rechazo, monto_facturado, tiempo_procesamiento)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [solicitud.folio, solicitud.resultado, solicitud.motivo_rechazo, solicitud.monto_facturado, null]
          );
        } catch (dbErr) {
          console.warn('No se pudo guardar en BD:', dbErr.message);
        }
      }
    } catch (error) {
      console.error('❌ Error al llamar n8n:', error.message);
      solicitud.status = 'procesando';
    }

    res.json({
      success: true,
      folio: solicitud.folio,
      mensaje: 'Documentación recibida'
    });

  } catch (error) {
    console.error('Error en upload:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Consultar una solicitud por folio ---
app.get('/api/importacion/status/:folio', async (req, res) => {
  try {
    const { folio } = req.params;

    const result = await pool.query(
      `SELECT
         e.folio, e.status, e.resultado, e.motivo_rechazo, e.monto_facturado,
         e.nombre_cliente, e.rfc_cliente, e.numero_factura, e.numero_pedido,
         e.tiempo_procesamiento, e.fecha_creacion, e.fecha_actualizacion,
         COALESCE(
           json_agg(json_build_object('tipo', v.tipo_validacion, 'resultado', v.resultado, 'detalle', v.detalle))
           FILTER (WHERE v.id IS NOT NULL), '[]'
         ) AS validaciones
       FROM expedientes_importacion e
       LEFT JOIN validaciones_importacion v ON v.expediente_id = e.id
       WHERE e.folio = $1
       GROUP BY e.id`,
      [folio]
    );

    if (result.rows.length > 0) {
      return res.json(result.rows[0]);
    }

    // Fallback a memoria
    const solicitud = solicitudes.find(s => s.folio === folio);
    if (!solicitud) {
      return res.status(404).json({ error: 'Folio no encontrado' });
    }

    res.json({
      folio: solicitud.folio,
      status: solicitud.status,
      resultado: solicitud.resultado,
      motivo_rechazo: solicitud.motivo_rechazo,
      monto_facturado: solicitud.monto_facturado,
      validaciones: []
    });

  } catch (error) {
    console.error('Error en status:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- KPIs para el tablero ---
app.get('/api/importacion/kpis', async (req, res) => {
  try {
    const { periodo, desde, hasta } = req.query;
    const filtro = buildFiltroFecha(periodo, desde, hasta);
    const filtroExp = buildFiltroFechaCol('fecha_creacion', periodo, desde, hasta);

    const kpisQuery = `
      SELECT
        COUNT(*)::int AS total_expedientes,
        COUNT(*) FILTER (WHERE resultado = 'aprobado')::int AS aprobados,
        COUNT(*) FILTER (WHERE resultado = 'rechazado')::int AS rechazados,
        COUNT(*) FILTER (WHERE resultado = 'revision_manual')::int AS revision_manual,
        COALESCE(AVG(tiempo_procesamiento), 0)::numeric(10,2) AS tiempo_promedio,
        COALESCE(SUM(monto_facturado), 0)::numeric(15,2) AS monto_total
      FROM expedientes_importacion ${filtroExp.whereClause};
    `;

    const causasQuery = `
      SELECT motivo_rechazo, COUNT(*)::int AS cantidad
      FROM expedientes_importacion
      WHERE resultado = 'rechazado' AND motivo_rechazo IS NOT NULL ${filtroExp.where}
      GROUP BY motivo_rechazo
      ORDER BY cantidad DESC
      LIMIT 10;
    `;

    const tendenciaQuery = `
      SELECT
        DATE(fecha_creacion) AS dia,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE resultado = 'aprobado')::int AS aprobados,
        COUNT(*) FILTER (WHERE resultado = 'rechazado')::int AS rechazados
      FROM expedientes_importacion ${filtroExp.whereClause}
      GROUP BY DATE(fecha_creacion)
      ORDER BY dia DESC
      LIMIT 30;
    `;

    const [kpis, causas, tendencia] = await Promise.all([
      pool.query(kpisQuery),
      pool.query(causasQuery),
      pool.query(tendenciaQuery)
    ]);

    res.json({
      resumen: kpis.rows[0],
      causas_rechazo: causas.rows,
      tendencia: tendencia.rows
    });

  } catch (error) {
    console.error('Error en KPIs:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Expedientes recientes ---
app.get('/api/importacion/expedientes-recientes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        e.folio,
        e.nombre_cliente,
        e.monto_facturado,
        e.moneda,
        e.resultado,
        e.status,
        e.motivo_rechazo,
        e.fecha_creacion AS fecha
      FROM expedientes_importacion e
      ORDER BY e.fecha_creacion DESC
      LIMIT 10;
    `);
    res.json({ expedientes: result.rows });
  } catch (error) {
    console.error('Error en expedientes-recientes:', error.message);
    // Fallback a memoria
    const recientes = solicitudes.slice(-10).reverse().map(s => ({
      folio: s.folio,
      nombre_cliente: s.nombre_cliente,
      monto_facturado: s.monto_facturado,
      moneda: s.moneda,
      resultado: s.resultado,
      status: s.status,
      motivo_rechazo: s.motivo_rechazo,
      fecha: s.fecha
    }));
    res.json({ expedientes: recientes });
  }
});

// --- Recomendaciones de IA con Ollama ---
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';

function sinAcentos(str) {
  if (!str) return str;
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function pedirRecomendacionOllama(causa, cantidad) {
  const prompt =
    'Eres un experto en procesos de importacion y comercio exterior en Mexico. ' +
    'Se han detectado ' + cantidad + ' expedientes rechazados por la causa: "' + causa + '". ' +
    'Responde UNICAMENTE con un JSON con este formato exacto, sin texto adicional, sin acentos ni caracteres especiales:\n' +
    '{"recomendacion": "accion concreta en una oracion sin acentos", "pasos": ["paso 1", "paso 2", "paso 3"], "prioridad": "alta|media|baja"}';

  const response = await fetch(OLLAMA_URL + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json();
  const texto = (data.response || '').trim();
  const match = texto.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  return { recomendacion: texto, pasos: [], prioridad: 'media' };
}

// GET — leer recomendaciones guardadas (por fecha, default hoy)
app.get('/api/importacion/recomendaciones', async (req, res) => {
  try {
    const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);

    const saved = await pool.query(
      `SELECT causa, frecuencia, recomendacion, pasos, prioridad, modelo, fecha_generacion
       FROM recomendaciones_ia
       WHERE fecha = $1
       ORDER BY
         CASE prioridad WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
         frecuencia DESC`,
      [fecha]
    );

    // Obtener lista de fechas disponibles para el historial
    const fechas = await pool.query(
      `SELECT DISTINCT fecha::text, COUNT(*)::int AS total
       FROM recomendaciones_ia
       GROUP BY fecha
       ORDER BY fecha DESC
       LIMIT 30`
    );

    res.json({
      recomendaciones: saved.rows,
      modelo: saved.rows[0]?.modelo || null,
      fecha,
      fechas_disponibles: fechas.rows
    });
  } catch (error) {
    console.error('Error leyendo recomendaciones:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST — generar con Ollama y guardar/actualizar en BD
app.post('/api/importacion/recomendaciones/generar', async (req, res) => {
  try {
    const fecha = new Date().toISOString().slice(0, 10);

    const causas = await pool.query(
      `SELECT motivo_rechazo, COUNT(*)::int AS cantidad
       FROM resultados_importacion
       WHERE resultado = 'rechazado' AND motivo_rechazo IS NOT NULL
       GROUP BY motivo_rechazo
       ORDER BY cantidad DESC
       LIMIT 5`
    );

    if (!causas.rows.length) {
      return res.json({ recomendaciones: [], modelo: OLLAMA_MODEL, fecha, fechas_disponibles: [] });
    }

    const recomendaciones = await Promise.all(
      causas.rows.map(async (c) => {
        let ia;
        try {
          ia = await pedirRecomendacionOllama(c.motivo_rechazo, c.cantidad);
        } catch (err) {
          console.warn('Ollama fallo para "' + c.motivo_rechazo + '":', err.message);
          ia = { recomendacion: 'Revisar proceso: ' + sinAcentos(c.motivo_rechazo), pasos: [], prioridad: 'media' };
        }

        // Guardar o actualizar en BD (UPSERT por fecha+causa)
        await pool.query(
          `INSERT INTO recomendaciones_ia (fecha, causa, frecuencia, recomendacion, pasos, prioridad, modelo, fecha_generacion)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (fecha, causa)
           DO UPDATE SET
             frecuencia = EXCLUDED.frecuencia,
             recomendacion = EXCLUDED.recomendacion,
             pasos = EXCLUDED.pasos,
             prioridad = EXCLUDED.prioridad,
             modelo = EXCLUDED.modelo,
             fecha_generacion = NOW()`,
          [fecha, sinAcentos(c.motivo_rechazo), c.cantidad, sinAcentos(ia.recomendacion), JSON.stringify((ia.pasos||[]).map(sinAcentos)), ia.prioridad || 'media', OLLAMA_MODEL]
        );

        return {
          causa: sinAcentos(c.motivo_rechazo),
          frecuencia: c.cantidad,
          recomendacion: sinAcentos(ia.recomendacion),
          pasos: (ia.pasos || []).map(sinAcentos),
          prioridad: ia.prioridad || 'media',
          modelo: OLLAMA_MODEL,
          fecha_generacion: new Date().toISOString()
        };
      })
    );

    const fechas = await pool.query(
      `SELECT DISTINCT fecha::text, COUNT(*)::int AS total
       FROM recomendaciones_ia
       GROUP BY fecha
       ORDER BY fecha DESC
       LIMIT 30`
    );

    res.json({ recomendaciones, modelo: OLLAMA_MODEL, fecha, fechas_disponibles: fechas.rows });
  } catch (error) {
    console.error('Error generando recomendaciones:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Métricas avanzadas ---
app.get('/api/importacion/metricas-avanzadas', async (req, res) => {
  try {
    const { periodo, desde, hasta } = req.query;
    const filtro = buildFiltroFecha(periodo, desde, hasta);
    // expedientes_importacion usa fecha_creacion
    const filtroExp = buildFiltroFechaCol('fecha_creacion', periodo, desde, hasta);

    const [tiempoRes, volumenRes, montoRes, sparkRes, causasRes, topExRes, topFaRes] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(AVG(tiempo_procesamiento), 0)::numeric(10,2) AS promedio,
          COALESCE(MIN(tiempo_procesamiento), 0)::numeric(10,2) AS minimo,
          COALESCE(MAX(tiempo_procesamiento), 0)::numeric(10,2) AS maximo
        FROM resultados_importacion WHERE tiempo_procesamiento IS NOT NULL ${filtro.where}`),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE resultado = 'aprobado')::int AS exitosas,
          COUNT(*) FILTER (WHERE resultado = 'rechazado')::int AS rechazadas,
          COUNT(*)::int AS total
        FROM expedientes_importacion ${filtroExp.whereClause}`),
      pool.query(`
        SELECT
          COALESCE(SUM(monto_facturado) FILTER (WHERE resultado = 'aprobado'), 0)::numeric(15,2) AS exitosas,
          COALESCE(SUM(monto_facturado) FILTER (WHERE resultado = 'rechazado'), 0)::numeric(15,2) AS fallidas
        FROM expedientes_importacion ${filtroExp.whereClause}`),
      pool.query(`
        SELECT
          DATE(fecha_creacion) AS dia,
          COUNT(*) FILTER (WHERE resultado = 'aprobado')::int AS exitosas,
          COUNT(*) FILTER (WHERE resultado = 'rechazado')::int AS rechazadas,
          COALESCE(AVG(tiempo_procesamiento), 0)::numeric(10,2) AS tiempo_prom,
          COALESCE(SUM(monto_facturado) FILTER (WHERE resultado = 'aprobado'), 0)::numeric(15,2) AS monto_ex,
          COALESCE(SUM(monto_facturado) FILTER (WHERE resultado = 'rechazado'), 0)::numeric(15,2) AS monto_fa
        FROM expedientes_importacion ${filtroExp.whereClause}
        GROUP BY DATE(fecha_creacion) ORDER BY dia ASC LIMIT 30`),
      pool.query(`
        SELECT motivo_rechazo, COUNT(*)::int AS cantidad
        FROM expedientes_importacion
        WHERE resultado = 'rechazado' AND motivo_rechazo IS NOT NULL ${filtroExp.where}
        GROUP BY motivo_rechazo ORDER BY cantidad DESC LIMIT 5`),
      pool.query(`
        SELECT numero_factura AS factura, monto_facturado::numeric(15,2) AS monto
        FROM expedientes_importacion
        WHERE resultado = 'aprobado' AND numero_factura IS NOT NULL ${filtroExp.where}
        ORDER BY monto_facturado DESC LIMIT 5`),
      pool.query(`
        SELECT numero_factura AS factura, monto_facturado::numeric(15,2) AS monto
        FROM expedientes_importacion
        WHERE resultado = 'rechazado' AND numero_factura IS NOT NULL ${filtroExp.where}
        ORDER BY monto_facturado DESC LIMIT 5`)
    ]);

    res.json({
      tiempo: tiempoRes.rows[0],
      volumen: volumenRes.rows[0],
      monto: montoRes.rows[0],
      spark: sparkRes.rows,
      causas_top5: causasRes.rows,
      top_exitosas: topExRes.rows,
      top_fallidas: topFaRes.rows
    });
  } catch (error) {
    console.error('Error en metricas-avanzadas:', error);
    res.status(500).json({ error: error.message });
  }
});

function buildFiltroFechaCol(col, periodo, desde, hasta) {
  if (desde && hasta) {
    return {
      where: `AND ${col}::date BETWEEN '${desde}' AND '${hasta}'`,
      whereClause: `WHERE ${col}::date BETWEEN '${desde}' AND '${hasta}'`
    };
  }
  if (periodo === '7d')  return { where: `AND ${col} >= NOW() - INTERVAL '7 days'`,  whereClause: `WHERE ${col} >= NOW() - INTERVAL '7 days'` };
  if (periodo === 'hoy') return { where: `AND ${col}::date = CURRENT_DATE`,            whereClause: `WHERE ${col}::date = CURRENT_DATE` };
  if (periodo === '30d') return { where: `AND ${col} >= NOW() - INTERVAL '30 days'`,  whereClause: `WHERE ${col} >= NOW() - INTERVAL '30 days'` };
  return { where: '', whereClause: '' };
}

function buildFiltroFecha(periodo, desde, hasta) {
  if (desde && hasta) {
    return {
      where: `AND fecha::date BETWEEN '${desde}' AND '${hasta}'`,
      whereClause: `WHERE fecha::date BETWEEN '${desde}' AND '${hasta}'`,
      params: []
    };
  }
  if (!periodo || periodo === '30d') {
    return {
      where: `AND fecha >= NOW() - INTERVAL '30 days'`,
      whereClause: `WHERE fecha >= NOW() - INTERVAL '30 days'`,
      params: []
    };
  }
  if (periodo === '7d') {
    return {
      where: `AND fecha >= NOW() - INTERVAL '7 days'`,
      whereClause: `WHERE fecha >= NOW() - INTERVAL '7 days'`,
      params: []
    };
  }
  if (periodo === 'hoy') {
    return {
      where: `AND fecha::date = CURRENT_DATE`,
      whereClause: `WHERE fecha::date = CURRENT_DATE`,
      params: []
    };
  }
  // sin filtro de fecha (muestra todo)
  return { where: '', whereClause: '', params: [] };
}

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
  console.log(`📋 Formulario:       http://localhost:${PORT}/index.html`);
  console.log(`📊 Dashboard:        http://localhost:${PORT}/dashboard.html`);
  console.log(`💡 Recomendaciones:  http://localhost:${PORT}/recomendaciones.html`);
  console.log(`🔍 Seguimiento:      http://localhost:${PORT}/seguimiento.html`);
});