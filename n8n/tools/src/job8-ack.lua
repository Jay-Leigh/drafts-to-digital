local c=redis.call('HMGET',KEYS[1],'kh','st','cl')
if not c[1] or c[1]~=ARGV[1] then return 2 end
if c[2]=='running' then return 0 end
if c[2]=='collected' then return 1 end
if c[2]=='succeeded' then
  if c[3] and c[3]~='' and c[3]~=ARGV[2] then return 3 end
  redis.call('HSET',KEYS[1],'st','collected','co',ARGV[3])
  redis.call('HDEL',KEYS[1],'cl','cla','x','rb')
  redis.call('DEL',KEYS[2])
  redis.call('EXPIRE',KEYS[1],ARGV[4])
  return 1
end
redis.call('DEL',KEYS[1],KEYS[2]) return 1
