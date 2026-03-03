import requests

url = "http://localhost:8001/api/upload"
files = {"file": ("test.csv", b"date,time,duration,a_number,b_number,calltype\n2023-01-01,12:00:00,60,123,456,Voice\ndate,time,duration,a_number,b_number,calltype\n2023-01-01,12:05:00,120,123,789,Voice")}
r = requests.post(url, files=files)
print(r.json())
