# microcache-cli.ps1
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$tcp = New-Object System.Net.Sockets.TcpClient('127.0.0.1', 6379)
$stream = $tcp.GetStream()
$writer = New-Object System.IO.StreamWriter($stream)
$reader = New-Object System.IO.StreamReader($stream)
$writer.AutoFlush = $true

Write-Host "Connecte a MicroCache. Tape 'exit' pour quitter." -ForegroundColor Green

function Read-Response {
    $line = $reader.ReadLine()
    if ($line -eq $null) { return "connexion fermee" }

    $prefix = $line[0]
    $data   = $line.Substring(1)

    switch ($prefix) {
        '+' { return $data }                          # Simple string : +OK
        '-' { return "ERR $data" }                   # Erreur        : -ERR ...
        ':' { return $data }                          # Integer       : :42
        '$' {                                         # Bulk string   : $5\r\nhello
            $len = [int]$data
            if ($len -eq -1) { return "(nil)" }
            $value = $reader.ReadLine()
            return $value
        }
        '*' {                                         # Array (KEYS etc.)
            $count = [int]$data
            $items = @()
            for ($i = 0; $i -lt $count; $i++) {
                $items += Read-Response
            }
            return $items -join ", "
        }
        default { return $line }                      # Fallback texte brut
    }
}

while ($true) {
    $cmd = Read-Host "microcache"
    if ($cmd -eq "exit") { break }
    $writer.WriteLine($cmd)
    $response = Read-Response
    Write-Host "-> $response" -ForegroundColor Cyan
}

$tcp.Close()