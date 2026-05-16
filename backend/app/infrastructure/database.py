from contextlib import contextmanager
from typing import List, Optional
from psycopg2 import pool
from app.core.config import settings
from app.domain.weather_models import InternalDisasterEvent

class DatabasePoolManager:
    _pool: Optional[pool.ThreadedConnectionPool] = None

    @classmethod
    def init_pool(cls):
        if cls._pool is None:
            try:
                cls._pool = pool.ThreadedConnectionPool(
                    minconn=settings.DB_POOL_MIN_CONN,
                    maxconn=settings.DB_POOL_MAX_CONN,
                    dsn=settings.DATABASE_URL
                )
                print("Supabase PostgreSQL connection pool initialized.")
            except Exception as e:
                print(f"Failed to initialize database pool: {e}")

    @classmethod
    def close_pool(cls):
        if cls._pool is not None:
            cls._pool.closeall()
            cls._pool = None
            print("Supabase PostgreSQL connection pool closed.")

    @classmethod
    @contextmanager
    def get_connection(cls):
        if cls._pool is None:
            cls.init_pool()
        if cls._pool is None:
            raise RuntimeError("Database connection pool is not initialized.")
        conn = cls._pool.getconn()
        try:
            yield conn
        finally:
            cls._pool.putconn(conn)

class DisasterRepository:
    @classmethod
    def get_active_weather_disasters(cls) -> List[InternalDisasterEvent]:
        weather_types = ('Flood', 'Wildfire', 'Heatwave', 'Power_Outage', 'Road_Blockage', 'Infrastructure_Failure')
        query = """
            SELECT id, disaster_type, severity, notes, status, created_at
            FROM disaster_events
            WHERE disaster_type IN %s AND status = 'active';
        """
        events = []
        try:
            with DatabasePoolManager.get_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(query, (weather_types,))
                    rows = cur.fetchall()
                    for row in rows:
                        events.append(InternalDisasterEvent(
                            id=str(row[0]),
                            disaster_type=str(row[1]),
                            severity=int(row[2]),
                            notes=str(row[3]) if row[3] else None,
                            status=str(row[4]),
                            created_at=str(row[5])
                        ))
        except Exception as e:
            print(f"[DisasterRepository] Query warning: {e}")
        return events
