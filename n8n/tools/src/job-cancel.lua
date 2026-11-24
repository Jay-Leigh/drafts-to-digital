local c=redis.call('HMGET',KEYS[1],'kh','st')
if not c[1] or c[1]~=ARGV[1] then return 'unknown' end
if c[2]=='running' or c[2]=='rejected' then
  redis.call('HSET',KEYS[1],'st','cancelled','f',ARGV[2]) redis.call('EXPIRE',KEYS[1],ARGV[3]) redis.call('DEL',KEYS[2]) return 'cancelled'
end
return c[2]
