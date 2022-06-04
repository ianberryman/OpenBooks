import mysql from 'mysql';
import config from '../config'

const pool = mysql.createPool(config.db)

export function query(
    queryString: string,
    values: Array<any> = []
): Promise<Array<any>> {
    return new Promise((resolve, reject) => {
        pool.query(queryString, values, (error, results, fields) => {
            if (error) {
                console.log(error)
                reject(error)
            }
            if (results) {
                resolve(results)
            }
        })
    })
}


