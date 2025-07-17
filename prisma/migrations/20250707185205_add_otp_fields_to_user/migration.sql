-- AlterTable
ALTER TABLE "users" ADD COLUMN     "otp" VARCHAR(10),
ADD COLUMN     "otp_expires" TIMESTAMPTZ(6);
