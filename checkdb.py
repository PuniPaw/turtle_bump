
import os
import MySQLdb
from dotenv import load_dotenv

load_dotenv()

print("DB_HOST:", os.getenv("DB_HOST"))
print("DB_PORT:", os.getenv("DB_PORT"))
print("DB_USER:", os.getenv("DB_USER"))
print("DB_NAME:", os.getenv("DB_NAME"))

# 데이터베이스를 지정하지 않고 서버에 접속
conn = MySQLdb.connect(
    host=os.getenv("DB_HOST", "127.0.0.1"),
    user=os.getenv("DB_USER", "root"),
    passwd=os.getenv("DB_PASSWORD", ""),
    port=int(os.getenv("DB_PORT", "3306")),
    charset="utf8mb4"
)

try:
    with conn.cursor() as cur:
        cur.execute("SHOW DATABASES")
        databases = cur.fetchall()

        print("\n현재 Python에서 보이는 데이터베이스:")
        for db in databases:
            print(db[0])

finally:
    conn.close()
