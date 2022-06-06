import { DataSource }  from 'apollo-datasource'
import {newId, query} from './db'
import NotFoundError from '../errors/NotFoundError'
import {CreateProductInput, Product, UpdateProductInput} from '../types/Product/Product'
import {QuantityUnit} from '../types/QuantityUnit'

export default class ProductApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createProduct(input: CreateProductInput): Promise<Product> {
        const id = newId()
        const { name, description, unitPrice, quantityUnit } = input
        await query('INSERT INTO product SET id = unhex(?), ?',
            [
                id,
                {
                    product_name: name,
                    description,
                    unit_price: unitPrice,
                    quantity_unit: quantityUnit,
                }
            ])
        return this.getProductById(id)
    }

    async updateProduct(input: UpdateProductInput): Promise<Product> {
        const { id, name, description, unitPrice, quantityUnit } = input
        await query('UPDATE product SET ? WHERE id = unhex(?)', [
            {
                product_name: name,
                description,
                unit_price: unitPrice,
                quantity_unit: quantityUnit,
            },
            id
        ])
        return this.getProductById(id)
    }

    async deleteProduct(id: string): Promise<void> {
        await query('DELETE FROM product WHERE id = unhex(?)', [id])
    }

    async getProducts(): Promise<Array<Product>> {
        const products = await query('SELECT hex(id) as id, product_name, description, unit_price, quantity_unit FROM product')
        return products.map(product => ({
            id: product.id,
            name: product.product_name,
            description: product.description,
            unitPrice: product.unit_price,
            quantityUnit: product.quantity_unit,
        }))
    }

    async getProductById(id: string): Promise<Product> {
        const results = await query('SELECT hex(id) as id, product_name, description, unit_price, quantity_unit FROM product WHERE id = unhex(?)', [id])

        const product = results[0]
        if (!product) throw new NotFoundError('Product with id: ' + id + ' not found')

        return {
            id: product.id,
            name: product.product_name,
            description: product.description,
            unitPrice: product.unit_price,
            quantityUnit: product.quantity_unit,
        }
    }
}