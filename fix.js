const fs = require('fs');
let text = fs.readFileSync('src/pages/app.astro', 'utf8');

// Replace curly braces with HTML entities globally in the HTML part
text = text.replace(/data-tag="\{\{([^}]+)\}\}"/g, 'data-tag="&#123;&#123;$1&#125;&#125;"');
text = text.replace(/#\{\{([^}]+)\}\}/g, '#&#123;&#123;$1&#125;&#125;');

// For the inline script block, we don't need to replace, Astro ignores inside <script is:inline> EXCEPT sometimes if it's treated as Astro variables. 
// Wait, if Astro still throws on the inline script, let's also escape the script curly braces by breaking them up, e.g., '{' + '{' 
text = text.replace(/\{\{([^}]+)\}\}/g, function(match, p1) {
    return '&#123;&#123;' + p1 + '&#125;&#125;';
});

fs.writeFileSync('src/pages/app.astro', text);
