import {mkdirSync,copyFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {setupTestDatabase} from '../helpers/test-db'
import {getDatabasePath,closeDatabase} from '@main/db/connection'
import {createWorker,workerBalances} from '@main/services/production/workers.service'
import {createRole,createUser} from '@main/services/admin/users.service'
import {createAccount,accountBalance} from '@main/services/finance/cash.service'
import {createCategory,createMaterial} from '@main/services/catalog/catalog.service'
import {createProduct} from '@main/services/products/products.service'
import {createSupplier} from '@main/services/parties/parties.service'
import {createPurchase} from '@main/services/purchasing/purchasing.service'
import {issueStandardStockFromBom} from '@main/services/production/production.service'
import {moneyFromMajor as m} from '@shared/money/money'
import {quantityFromDisplay as q} from '@shared/quantity/quantity'
const target = process.env.UIWF05_DIR
if (!target || !target.startsWith('/tmp/uiwf05-electron-')) throw new Error('Disposable UIWF05_DIR required')
const env=setupTestDatabase()
try {
 const workerId=createWorker({name:'عامل UI-WF-05'},env.ctx)
 const accountId=createAccount({name:'خزينة اختيار آمن',kind:'cash',openingBalanceMinor:m(100),notes:'SECRET CASH NOTE'},env.ctx)
 const categoryId=createCategory({name:'UIWF05'},env.ctx)
 const materialId=createMaterial({sku:'UIWF05-M',name:'مادة UIWF05',categoryId,unit:'unit',currentMarketPriceMicro:0,pricingRule:'exact'} as never,env.ctx)
 createPurchase({supplierId:createSupplier({name:'UIWF05 supplier'},env.ctx),lines:[{materialId,qtyMicro:q(1),unitCostMicro:0}]},env.ctx)
 const productId=createProduct({code:'UIWF05-P',name:'UIWF05 product',bom:[{materialId,qtyMicro:q(1),unit:'unit'}],commission:[{workerId,amountMinor:m(50)}]},env.ctx)
 issueStandardStockFromBom({productId,quantityMicro:q(1),requestKey:'uiwf05-earning-fixture'},env.ctx)
 const permissions=['workers.view','workers.finance'];const roleId=createRole({name:'UIWF05 payer',permissions},env.ctx)
 createUser({username:'uiwf05-payer',fullName:'UIWF05 payer',password:'secret123',roleId},env.ctx)
 const result={workerId,accountId,permissions,earnedMinor:m(50),payable:workerBalances(workerId),balanceMinor:accountBalance(accountId)}
 const source=getDatabasePath();closeDatabase();mkdirSync(join(target,'data'),{recursive:true});copyFileSync(source,join(target,'data/erp.db'));writeFileSync(join(target, 'fixture.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{env.cleanup()}
