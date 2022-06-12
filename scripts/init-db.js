import {createConnection} from "mysql2";
import config from "../src/config";

export async function initDb() {
  return new Promise((resolve, reject) => {
    let connection
    try {
      connection = createConnection({
        host: config.db.host,
        user: 'root',
        password: '',
        multipleStatements: true,
      })

      connection.query(
        `
                CREATE DATABASE IF NOT EXISTS openbooks;
                
                use openbooks;
    
                CREATE USER IF NOT EXISTS openbooksapi
                identified WITH mysql_native_password BY 'openbooks';
    
                GRANT ALL PRIVILEGES ON openbooks.* to 'openbooksapi'@'%';
              `, async (err, results) => {
          if (err) {
            console.log(err)
            reject()
          }

          connection.end()
          console.log('Initialization complete')
          resolve()
        }
      )
    } catch (err) {
      console.log(err)
      connection.end()
      reject()
    }
  })
}

initDb().catch(console.error)