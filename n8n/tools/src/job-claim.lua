local c=redis.call('HMGET',KEYS[1],'kh','st','cl','cla','m')
if not c[1] or c[1]~=ARGV[1] then return {'unknown'} end
if c[2]~='succeeded' then return {'state',c[2]} end
local now=tonumber(ARGV[3])
local cla=tonumber(c[4]) or 0
if c[3] and c[3]~='' and c[3]~=ARGV[2] and now-cla<tonumber(ARGV[4]) then return {'claimed'} end
local raw=redis.call('GET',KEYS[2])
if not raw then return {'unknown'} end
redis.call('HSET',KEYS[1],'cl',ARGV[2],'cla',ARGV[3])
return {'ok',c[5] or '',raw}
