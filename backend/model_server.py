import io, base64, json
from PIL import Image
import torch
import torch.nn as nn
import torchvision.transforms as T

class ModelServer:
    def __init__(self, model_path, idx2label_path, img_size=128):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.img_size = img_size

        # Load label mapping
        with open(idx2label_path, "r", encoding="utf-8") as f:
            self.idx2label = json.load(f)

        # Load pretrained model architecture (MobileNetV2)
        from torchvision.models import mobilenet_v2
        self.model = mobilenet_v2(pretrained=False)
        num_ftrs = self.model.classifier[1].in_features
        self.model.classifier[1] = nn.Linear(num_ftrs, len(self.idx2label))

        ckpt = torch.load(model_path, map_location=self.device)
        self.model.load_state_dict(ckpt["model_state_dict"])
        self.model.to(self.device)
        self.model.eval()

        self.transform = T.Compose([
            T.Resize((img_size, img_size)),
            T.ToTensor(),
            T.Normalize(
                mean=[0.485, 0.456, 0.406],
                std=[0.229, 0.224, 0.225]
            )
        ])

    def decode_frame(self, frame_b64):
        if frame_b64.startswith("data:"):
            frame_b64 = frame_b64.split(",")[1]

        img = Image.open(io.BytesIO(base64.b64decode(frame_b64)))
        return img.convert("RGB")

    def predict(self, frame_b64):
        img = self.decode_frame(frame_b64)
        x = self.transform(img).unsqueeze(0).to(self.device)

        with torch.no_grad():
            logits = self.model(x)
            probs = torch.softmax(logits, dim=1)[0]
            idx = probs.argmax().item()

        predicted_label = self.idx2label[str(idx)]
        return {
            "label": predicted_label,
            "score": float(probs[idx]),
            "index": int(idx)
        }
