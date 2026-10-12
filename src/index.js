export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ဥပမာ (၁) - Vector Database ထဲသို့ အချက်အလက်များ ထည့်သွင်းခြင်း (Insert)
    if (url.pathname === '/insert' && request.method === 'POST') {
      const vectorsToInsert = [
        {
          id: "doc-1",
          values: new Array(768).fill(0.1), // 768 dimensions အစားထိုးရန်
          metadata: { 
            department: "Ortho", 
            doctor: "Dr. Aung", 
            schedule: "Mon, Wed, Fri" 
          }
        }
      ];

      let inserted = await env.VECTOR_INDEX.insert(vectorsToInsert);
      return new Response(JSON.stringify({ success: true, inserted }), {
        headers: { "content-type": "application/json" }
      });
    }

    // ဥပမာ (၂) - Vector Database အတွင်း ရှာဖွေခြင်း (Similarity Search)
    if (url.pathname === '/query' && request.method === 'POST') {
      const requestBody = await request.json();
      const userQuestionVector = requestBody.vector; 

      const searchResults = await env.VECTOR_INDEX.query(userQuestionVector, {
        topK: 3,
        returnMetadata: "all" 
      });

      return new Response(JSON.stringify({ results: searchResults }), {
        headers: { "content-type": "application/json" }
      });
    }

    // (၃) - File Upload လက်ခံမည့် Endpoint
    if (url.pathname === '/upload-file' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('document'); 

        if (!file) {
          return new Response(JSON.stringify({ error: "No file uploaded" }), { 
            status: 400, 
            headers: { "content-type": "application/json" } 
          });
        }

        const fileText = await file.text();
        const fileName = file.name;

        // စာသားများကို အပိုင်းပိုင်းဖြတ်မည်
        const chunks = chunkText(fileText, 1000);

        if (chunks.length === 0) {
            return new Response(JSON.stringify({ error: "File ထဲတွင် စာသားမတွေ့ရပါ။" }), { 
              status: 400, 
              headers: { "content-type": "application/json" } 
            });
        }

        const vectorsToInsert = [];
        let chunkIndex = 1;

        // Worker AI ဖြင့် Vector Array ပြောင်းခြင်း
        for (const textChunk of chunks) {
            const embeddingResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
                text: [textChunk]
            });
            
            const vectorArray = embeddingResponse.data[0];

            vectorsToInsert.push({
                id: `doc_${Date.now()}_chunk_${chunkIndex}`, 
                values: vectorArray,
                metadata: {
                    sourceFile: fileName,
                    content: textChunk 
                }
            });
            
            chunkIndex++;
        }

        // Vectorize DB သို့ ထည့်ခြင်း
        const inserted = await env.VECTOR_INDEX.insert(vectorsToInsert);

        return new Response(JSON.stringify({ 
          success: true, 
          message: `File '${fileName}' ကို အောင်မြင်စွာ Vector ပြောင်းပြီး သိမ်းဆည်းပြီးပါပြီ။`,
          totalChunks: chunks.length,
          insertedCount: inserted.count
        }), {
          headers: { "content-type": "application/json" }
        });

      } catch (error) {
        console.error("Upload Error:", error);
        return new Response(JSON.stringify({ error: error.message }), { 
          status: 500, 
          headers: { "content-type": "application/json" } 
        });
      }
    }

    return new Response("Hospital RAG API is running!");
  },
};

// ── Helper Function (fetch ပြင်ပတွင် သီးသန့်ထားရပါမည်) ──
function chunkText(text, maxLength = 1000) {
    const chunks = [];
    let startIndex = 0;
    
    while (startIndex < text.length) {
        let endIndex = startIndex + maxLength;
        
        if (endIndex < text.length) {
            let lastSpace = text.lastIndexOf(' ', endIndex);
            if (lastSpace > startIndex) {
                endIndex = lastSpace;
            }
        }
        
        const chunk = text.substring(startIndex, endIndex).trim();
        if (chunk.length > 0) {
            chunks.push(chunk);
        }
        
        startIndex = endIndex;
    }
    return chunks;
}