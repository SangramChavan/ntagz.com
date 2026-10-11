-- LOCAL TEST DATA ONLY (never run against production). Payment columns are explicit because migration 0003 removed the insert trigger.
INSERT INTO orders (id,txn_id,gateway,status,name,phone,email,address,pincode,state,items_json,subtotal,gst,total,payment_method,payment_status,paid_paise) VALUES
 ('11111111-aaaa-bbbb-cccc-000000000001','tx1','razorpay','confirmed','Asha Online','9000000001','asha@example.test','1 Main St','411001','Maharashtra','[{"id":"black-nfc-card","qty":10}]',30000,5400,35400,'razorpay','paid',35400),
 ('22222222-aaaa-bbbb-cccc-000000000002','tx2','cash','confirmed','Ravi Cash','9000000002','ravi@example.test','2 Lake Rd','560001','Karnataka','[{"id":"nfc-coin","qty":20}]',40000,7200,47200,'cash','unpaid',0),
 ('33333333-aaaa-bbbb-cccc-000000000003','tx3','cod','shipped','Meera COD','9000000003','meera@example.test','3 Hill Ave','110001','Delhi','[{"id":"anti-metal-tag","qty":10}]',20000,3600,23600,'cod','unpaid',0),
 ('44444444-aaaa-bbbb-cccc-000000000004','tx4','payu','delivered','=cmd|evil','9000000004','x@example.test','4 Park','400001','Maharashtra','[]',10000,1800,11800,'payu','paid',11800),
 ('55555555-aaaa-bbbb-cccc-000000000005','OFF-QT-ABC123-9000000005','upi','confirmed','Uma UPI','9000000005','uma@example.test','5 River Rd','380001','Gujarat','[{"id":"nfc-coin","qty":10}]',20000,3600,23600,'upi','unpaid',0),
 ('66666666-aaaa-bbbb-cccc-000000000006','OFF-QT-DEF456-9000000006','whatsapp','confirmed','Wali WhatsApp','9000000006','','6 Fort Rd','500001','Telangana','[{"id":"mini-nfc-tag","qty":10}]',16000,2880,18880,'whatsapp','unpaid',0);

-- Pre-order: paid, 2 units came from ready stock and 3 are pre-ordered. nfc-coin is tracked with pre-orders on (ready stock is 0 after the order).
INSERT INTO orders (id,txn_id,gateway,status,name,phone,email,address,pincode,state,items_json,subtotal,gst,total,payment_method,payment_status,paid_paise,is_preorder) VALUES
 ('77777777-aaaa-bbbb-cccc-000000000007','tx7','razorpay','preorder_confirmed','Pia Preorder','9000000007','pia@example.test','7 Dock Rd','600001','Tamil Nadu','[{"id":"nfc-coin","qty":5}]',50000,9000,59000,'razorpay','paid',59000,1);
INSERT INTO order_stock_lines (order_id,product_id,ready_qty,pre_qty) VALUES ('77777777-aaaa-bbbb-cccc-000000000007','nfc-coin',2,3);
UPDATE products SET track_stock=1, preorder_enabled=1, preordered_qty=3 WHERE id='nfc-coin';
