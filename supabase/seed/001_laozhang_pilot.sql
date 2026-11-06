-- Pilot 店家資料：老張麵店
-- Run only after migration 0001. Idempotent by tenant slug/category/product name.
begin;
insert into public.tenants(name,slug,phone,address,currency)
values ('老張麵店','laozhang','0977-222-138','台北市信義區永吉路30巷158弄1號','TWD')
on conflict(slug) do update set name=excluded.name,phone=excluded.phone,address=excluded.address;

with t as (select id from public.tenants where slug='laozhang'),
c(name,sort_order) as (values ('湯麵類',1),('乾麵類',2),('湯類',3),('小菜',4),('飯類',5))
insert into public.categories(tenant_id,name,sort_order)
select t.id,c.name,c.sort_order from t cross join c
on conflict(tenant_id,name) do update set sort_order=excluded.sort_order;

with p(category,name,description,price,sort_order) as (values
('湯麵類','海鮮湯麵','蛋、蝦、蛤、蚵、小卷',180,1),
('湯麵類','綜合湯麵','蛤、蚵、肉、豬肝',150,2),
('湯麵類','餛飩湯麵','',90,3),
('湯麵類','酸辣清湯麵','',90,4),
('乾麵類','紅油皮蛋抄手麵','',140,5),
('乾麵類','麻醬皮蛋抄手麵','',140,6),
('乾麵類','紅油抄手麵','',110,7),
('乾麵類','麻醬抄手麵','',110,8),
('乾麵類','紅油皮蛋麵','',100,9),
('乾麵類','麻醬皮蛋麵','',100,10),
('乾麵類','餛飩乾麵','',90,11),
('乾麵類','紅油酸辣麵','含花生碎',60,12),
('乾麵類','麻醬麵','',60,13),
('湯類','海鮮湯','蛋、蝦、蛤、蚵、小卷',170,14),
('湯類','綜合湯','蛤、蚵、肉、豬肝',140,15),
('湯類','餛飩湯','',80,16),
('湯類','酸辣清湯','',80,17),
('湯類','豬肝湯','',60,18),
('湯類','貢丸湯','',40,19),
('小菜','紅油抄手','',90,20),
('小菜','麻醬抄手','',90,21),
('小菜','三色蛋','',60,22),
('小菜','粉肝','',60,23),
('小菜','鯊魚煙','',60,24),
('小菜','燙青菜','',40,25),
('飯類','燒肉飯','',70,26),
('飯類','白飯','',20,27)
)
insert into public.products(tenant_id,category_id,name,description,price,sort_order)
select t.id,c.id,p.name,p.description,p.price,p.sort_order
from public.tenants t join p on true join public.categories c on c.tenant_id=t.id and c.name=p.category
where t.slug='laozhang'
on conflict do nothing;
commit;

-- 店家自訂選項（待後續 product modifiers schema）：升級燒肉飯 +30 元；加麵 +20 元。
