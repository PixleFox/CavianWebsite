/*
  Warnings:

  - You are about to drop the column `sku` on the `Product` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Product_sku_key";

-- DropIndex
DROP INDEX "Variant_sku_key";

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "sku",
ALTER COLUMN "totalStock" SET DEFAULT 0;
