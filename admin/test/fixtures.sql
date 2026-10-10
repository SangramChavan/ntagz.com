-- LOCAL TEST DATA ONLY (never run against production)
INSERT INTO orders (id,txn_id,gateway,status,name,phone,email,address,pincode,state,items_json,subtotal,gst,total) VALUES
 ('11111111-aaaa-bbbb-cccc-000000000001','tx1','razorpay','confirmed','Asha Online','9000000001','asha@example.test','1 Main St','411001','Maharashtra','[{"id":"black-nfc-card","qty":10}]',30000,5400,35400),
 ('22222222-aaaa-bbbb-cccc-000000000002','tx2','cash','confirmed','Ravi Cash','9000000002','ravi@example.test','2 Lake Rd','560001','Karnataka','[{"id":"nfc-coin","qty":20}]',40000,7200,47200),
 ('33333333-aaaa-bbbb-cccc-000000000003','tx3','cod','shipped','Meera COD','9000000003','meera@example.test','3 Hill Ave','110001','Delhi','[{"id":"anti-metal-tag","qty":10}]',20000,3600,23600),
 ('44444444-aaaa-bbbb-cccc-000000000004','tx4','payu','delivered','=cmd|evil','9000000004','x@example.test','4 Park','400001','Maharashtra','[]',10000,1800,11800);
