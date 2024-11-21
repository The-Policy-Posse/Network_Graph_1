from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
from flask_caching import Cache
from sqlalchemy import create_engine, text
import os
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__, static_folder='.')
CORS(app)
cache = Cache(app, config={'CACHE_TYPE': 'simple'})

# Cache duration
hour = 3600
CACHE_DURATION = 2*hour

def get_db_connection():
    """Create SQLAlchemy engine with connection details"""
    db_params = {
            'user': os.getenv('DB_USER', 'username'),
            'password': os.getenv('DB_PASSWORD', 'password'),
            'host': os.getenv('DB_HOST', 'localhost'),
            'port': os.getenv('DB_PORT', '5433'),
            'database': os.getenv('DB_NAME', 'database')
        }
    
    connection_string = f"postgresql://{db_params['user']}:{db_params['password']}@{db_params['host']}:{db_params['port']}/{db_params['database']}"
    return create_engine(connection_string)

@cache.cached(timeout=CACHE_DURATION, key_prefix='network_data')
def get_network_data():
    """Get network data from database with caching"""
    try:
        print("Fetching data from database...")  # Debug print
        engine = get_db_connection()
        
        with engine.connect() as conn:
            result = conn.execute(text("""
                SELECT data 
                FROM network_data 
                ORDER BY created_at DESC 
                LIMIT 1;
            """))
            row = result.fetchone()
            if row:
                print("Data successfully fetched from database")  # Debug print
                return row[0]
            print("No data found in database")  # Debug print
            return None
    except Exception as e:
        print(f"Database error: {e}")  # Debug print
        return None

@app.route('/api/network-data')
def network_data():
    """API endpoint to get network data"""
    data = get_network_data()
    if data:
        return jsonify(data)
    return jsonify({'error': 'No data available'}), 404

@app.route('/')
def serve_index():
    """Serve the main HTML file"""
    return send_from_directory('.', 'network_sql.html')

@app.route('/<path:path>')
def serve_static(path):
    """Serve static files"""
    return send_from_directory('.', path)

if __name__ == '__main__':
    print("Starting Flask server...")  # Debug print
    app.run(port=5500, debug=True)