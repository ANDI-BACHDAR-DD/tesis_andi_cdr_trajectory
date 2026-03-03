import requests

url = "http://localhost:8001/api/upload"
csv_data = b"maid,latitude,longitude,timestamp\n123,-6.2,106.8,2023-01-01 12:00:00\n123,-6.21,106.81,2023-01-01 12:05:00"
files = {"file": ("test2.csv", csv_data)}
r = requests.post(url, files=files)
print(r.json())
