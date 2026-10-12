-- Tabla para guardar recomendaciones generadas por Ollama
CREATE TABLE IF NOT EXISTS recomendaciones_ia (
    id                  SERIAL PRIMARY KEY,
    fecha               DATE NOT NULL DEFAULT CURRENT_DATE,
    causa               TEXT NOT NULL,
    frecuencia          INTEGER NOT NULL DEFAULT 0,
    recomendacion       TEXT NOT NULL,
    pasos               JSONB DEFAULT '[]',
    prioridad           VARCHAR(10) DEFAULT 'media',
    modelo              VARCHAR(50),
    fecha_generacion    TIMESTAMP DEFAULT NOW(),
    CONSTRAINT chk_prioridad CHECK (prioridad IN ('alta', 'media', 'baja')),
    -- Una causa por día (si se regenera el mismo día, se actualiza)
    CONSTRAINT uq_causa_fecha UNIQUE (fecha, causa)
);

CREATE INDEX IF NOT EXISTS idx_recomendaciones_fecha ON recomendaciones_ia(fecha);
