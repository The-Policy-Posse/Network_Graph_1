const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = 5500;

// Enable CORS
app.use(cors());

// Serve static files from the current directory
app.use(express.static(__dirname));

// PostgreSQL connection pool
const pool = new Pool({
    user: process.env.DB_USER || 'username',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'database',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

// Test database connection
pool.connect((err) => {
    if (err) {
        console.error('Error connecting to PostgreSQL:', err);
    } else {
        console.log('Connected to PostgreSQL database');
    }
});

// API Endpoint to fetch network data
app.get('/api/network-data', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT data
            FROM network_data
            ORDER BY created_at DESC
            LIMIT 1
        `);
        if (result.rows.length > 0) {
            res.json(result.rows[0].data);
        } else {
            res.status(404).json({ error: 'No data available' });
        }
    } catch (err) {
        console.error('Database query error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});