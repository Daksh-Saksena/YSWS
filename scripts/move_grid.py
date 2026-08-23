import re
with open('index.html', 'r') as f:
    content = f.read()
grid_pattern = r'(    <!-- Grid Placement System.*?<div id="placement-grid".*?)\n    <style>'
match = re.search(grid_pattern, content, flags=re.DOTALL)
if not match:
    print("Could not find grid!")
    exit(1)
grid_html = match.group(1).rstrip()
grid_html = re.sub(
    r'style="position: absolute; top: 0; left: 0; right: 0; display: grid;',
    'style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: grid;',
    grid_html
)
content = content.replace(match.group(1), '')
container_pattern = r'(<div class="image-container">\n        <img src="images/background.png" alt="High Quality Background">)'
if not re.search(container_pattern, content):
    print("Could not find image container!")
    exit(1)
content = re.sub(container_pattern, r'\1\n' + grid_html, content)
sync_pattern = r'            function syncGrid\(\) \{.*?\n            \}\n            syncGrid\(\);\n            window\.addEventListener\(\'resize\', syncGrid\);\n            setTimeout\(syncGrid, 500\); // safety\n'
content = re.sub(sync_pattern, '', content, flags=re.DOTALL)
with open('index.html', 'w') as f:
    f.write(content)
print("Done")
