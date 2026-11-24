local c=redis.call('HMGET',KEYS[1],'kh','st')
if c[1] and not (c[1]==ARGV[1] and c[2]=='rejected') then return 'duplicate' end
redis.call('HSET',KEYS[1],'kh',ARGV[1],'m',ARGV[2],'st','rejected','a',ARGV[3],'c',ARGV[4],'e',ARGV[5])
redis.call('EXPIRE',KEYS[1],ARGV[6]) return 'rejected'
